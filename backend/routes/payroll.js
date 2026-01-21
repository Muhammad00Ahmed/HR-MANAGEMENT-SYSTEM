const express = require('express');
const Employee = require('../models/Employee');
const Payroll = require('../models/Payroll');
const Attendance = require('../models/Attendance');
const { authenticate, authorize } = require('../middleware/auth');
const { calculateTax, calculateDeductions } = require('../utils/payroll');

const router = express.Router();

// Get all payroll records
router.get('/', authenticate, authorize(['admin', 'hr', 'payroll']), async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      month,
      year,
      department,
      status,
      sortBy = 'createdAt',
      order = 'desc'
    } = req.query;
    
    const query = {};
    
    // Filter by month and year
    if (month && year) {
      query.month = parseInt(month);
      query.year = parseInt(year);
    }
    
    // Filter by department
    if (department) {
      const employees = await Employee.find({ department }).select('_id');
      query.employee = { $in: employees.map(e => e._id) };
    }
    
    // Filter by status
    if (status) {
      query.status = status;
    }
    
    const payrolls = await Payroll.find(query)
      .populate('employee', 'firstName lastName employeeId department')
      .populate('processedBy', 'firstName lastName')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ [sortBy]: order === 'desc' ? -1 : 1 })
      .exec();
    
    const count = await Payroll.countDocuments(query);
    
    // Calculate totals
    const totals = await Payroll.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalGrossSalary: { $sum: '$grossSalary' },
          totalDeductions: { $sum: '$totalDeductions' },
          totalNetSalary: { $sum: '$netSalary' }
        }
      }
    ]);
    
    res.json({
      success: true,
      data: payrolls,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      total: count,
      summary: totals[0] || {
        totalGrossSalary: 0,
        totalDeductions: 0,
        totalNetSalary: 0
      }
    });
  } catch (error) {
    console.error('Error fetching payroll:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching payroll records'
    });
  }
});

// Get single payroll record
router.get('/:id', authenticate, async (req, res) => {
  try {
    const payroll = await Payroll.findById(req.params.id)
      .populate('employee', 'firstName lastName employeeId department position')
      .populate('processedBy', 'firstName lastName')
      .populate('approvedBy', 'firstName lastName')
      .exec();
    
    if (!payroll) {
      return res.status(404).json({
        success: false,
        message: 'Payroll record not found'
      });
    }
    
    // Check if user can view this payroll
    if (req.user.role === 'employee' && payroll.employee._id.toString() !== req.user.employeeId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    res.json({
      success: true,
      data: payroll
    });
  } catch (error) {
    console.error('Error fetching payroll:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching payroll record'
    });
  }
});

// Process payroll for a month
router.post('/process', authenticate, authorize(['admin', 'payroll']), async (req, res) => {
  try {
    const { month, year, employeeIds } = req.body;
    
    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: 'Month and year are required'
      });
    }
    
    // Check if payroll already processed
    const existingPayroll = await Payroll.findOne({
      month,
      year,
      employee: { $in: employeeIds }
    });
    
    if (existingPayroll) {
      return res.status(400).json({
        success: false,
        message: 'Payroll already processed for this period'
      });
    }
    
    // Get employees to process
    const query = employeeIds ? { _id: { $in: employeeIds } } : { status: 'active' };
    const employees = await Employee.find(query);
    
    const payrollRecords = [];
    
    for (const employee of employees) {
      // Get attendance for the month
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0);
      
      const attendance = await Attendance.find({
        employee: employee._id,
        date: { $gte: startDate, $lte: endDate }
      });
      
      // Calculate working days
      const workingDays = attendance.filter(a => a.status === 'present').length;
      const totalDays = attendance.length;
      const absentDays = attendance.filter(a => a.status === 'absent').length;
      const leaveDays = attendance.filter(a => a.status === 'leave').length;
      
      // Calculate overtime hours
      const overtimeHours = attendance.reduce((sum, a) => sum + (a.overtimeHours || 0), 0);
      
      // Calculate salary components
      const basicSalary = employee.salary.basic;
      const allowances = employee.salary.allowances || {};
      
      // Calculate gross salary
      let grossSalary = basicSalary;
      
      // Add allowances
      Object.values(allowances).forEach(allowance => {
        grossSalary += allowance;
      });
      
      // Add overtime pay
      const overtimePay = overtimeHours * (employee.salary.hourlyRate || 0);
      grossSalary += overtimePay;
      
      // Deduct for absent days (if applicable)
      const perDaySalary = basicSalary / 30;
      const absentDeduction = absentDays * perDaySalary;
      grossSalary -= absentDeduction;
      
      // Calculate deductions
      const taxAmount = calculateTax(grossSalary, employee.taxBracket);
      const providentFund = grossSalary * 0.12; // 12% PF
      const insurance = employee.salary.insurance || 0;
      const loanDeduction = employee.loans ? calculateLoanDeduction(employee.loans, month, year) : 0;
      
      const totalDeductions = taxAmount + providentFund + insurance + loanDeduction;
      
      // Calculate net salary
      const netSalary = grossSalary - totalDeductions;
      
      // Create payroll record
      const payroll = await Payroll.create({
        employee: employee._id,
        month,
        year,
        workingDays,
        absentDays,
        leaveDays,
        overtimeHours,
        basicSalary,
        allowances,
        overtimePay,
        grossSalary,
        deductions: {
          tax: taxAmount,
          providentFund,
          insurance,
          loan: loanDeduction,
          other: 0
        },
        totalDeductions,
        netSalary,
        status: 'pending',
        processedBy: req.user.id,
        processedAt: new Date()
      });
      
      payrollRecords.push(payroll);
    }
    
    res.status(201).json({
      success: true,
      data: payrollRecords,
      message: `Payroll processed for ${payrollRecords.length} employees`
    });
  } catch (error) {
    console.error('Error processing payroll:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing payroll'
    });
  }
});

// Approve payroll
router.post('/:id/approve', authenticate, authorize(['admin', 'hr']), async (req, res) => {
  try {
    const payroll = await Payroll.findById(req.params.id);
    
    if (!payroll) {
      return res.status(404).json({
        success: false,
        message: 'Payroll record not found'
      });
    }
    
    if (payroll.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Payroll is not in pending status'
      });
    }
    
    payroll.status = 'approved';
    payroll.approvedBy = req.user.id;
    payroll.approvedAt = new Date();
    await payroll.save();
    
    // Send notification to employee
    await sendPayrollNotification(payroll.employee, 'approved', payroll);
    
    res.json({
      success: true,
      data: payroll,
      message: 'Payroll approved successfully'
    });
  } catch (error) {
    console.error('Error approving payroll:', error);
    res.status(500).json({
      success: false,
      message: 'Error approving payroll'
    });
  }
});

// Reject payroll
router.post('/:id/reject', authenticate, authorize(['admin', 'hr']), async (req, res) => {
  try {
    const { reason } = req.body;
    
    const payroll = await Payroll.findById(req.params.id);
    
    if (!payroll) {
      return res.status(404).json({
        success: false,
        message: 'Payroll record not found'
      });
    }
    
    if (payroll.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Payroll is not in pending status'
      });
    }
    
    payroll.status = 'rejected';
    payroll.rejectionReason = reason;
    payroll.rejectedBy = req.user.id;
    payroll.rejectedAt = new Date();
    await payroll.save();
    
    res.json({
      success: true,
      data: payroll,
      message: 'Payroll rejected'
    });
  } catch (error) {
    console.error('Error rejecting payroll:', error);
    res.status(500).json({
      success: false,
      message: 'Error rejecting payroll'
    });
  }
});

// Generate payslip
router.get('/:id/payslip', authenticate, async (req, res) => {
  try {
    const payroll = await Payroll.findById(req.params.id)
      .populate('employee', 'firstName lastName employeeId department position')
      .exec();
    
    if (!payroll) {
      return res.status(404).json({
        success: false,
        message: 'Payroll record not found'
      });
    }
    
    // Check if user can view this payslip
    if (req.user.role === 'employee' && payroll.employee._id.toString() !== req.user.employeeId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    // Generate PDF payslip
    const pdf = await generatePayslipPDF(payroll);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=payslip-${payroll.employee.employeeId}-${payroll.month}-${payroll.year}.pdf`);
    res.send(pdf);
  } catch (error) {
    console.error('Error generating payslip:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating payslip'
    });
  }
});

// Get payroll summary
router.get('/summary/:year', authenticate, authorize(['admin', 'hr', 'payroll']), async (req, res) => {
  try {
    const { year } = req.params;
    
    const summary = await Payroll.aggregate([
      { $match: { year: parseInt(year) } },
      {
        $group: {
          _id: '$month',
          totalEmployees: { $sum: 1 },
          totalGrossSalary: { $sum: '$grossSalary' },
          totalDeductions: { $sum: '$totalDeductions' },
          totalNetSalary: { $sum: '$netSalary' },
          totalOvertimePay: { $sum: '$overtimePay' }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Error fetching payroll summary:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching payroll summary'
    });
  }
});

// Helper functions
function calculateLoanDeduction(loans, month, year) {
  let totalDeduction = 0;
  
  loans.forEach(loan => {
    if (loan.status === 'active') {
      // Calculate monthly installment
      totalDeduction += loan.monthlyInstallment || 0;
    }
  });
  
  return totalDeduction;
}

async function sendPayrollNotification(employeeId, type, payroll) {
  const Notification = require('../models/Notification');
  
  await Notification.create({
    user: employeeId,
    type: `payroll_${type}`,
    title: `Payroll ${type}`,
    message: `Your payroll for ${payroll.month}/${payroll.year} has been ${type}`,
    link: `/payroll/${payroll._id}`,
    read: false
  });
}

async function generatePayslipPDF(payroll) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument();
  
  // Add company logo and header
  doc.fontSize(20).text('Payslip', { align: 'center' });
  doc.moveDown();
  
  // Employee details
  doc.fontSize(12).text(`Employee: ${payroll.employee.firstName} ${payroll.employee.lastName}`);
  doc.text(`Employee ID: ${payroll.employee.employeeId}`);
  doc.text(`Department: ${payroll.employee.department}`);
  doc.text(`Position: ${payroll.employee.position}`);
  doc.text(`Month/Year: ${payroll.month}/${payroll.year}`);
  doc.moveDown();
  
  // Earnings
  doc.fontSize(14).text('Earnings', { underline: true });
  doc.fontSize(10);
  doc.text(`Basic Salary: $${payroll.basicSalary.toFixed(2)}`);
  
  Object.entries(payroll.allowances).forEach(([key, value]) => {
    doc.text(`${key}: $${value.toFixed(2)}`);
  });
  
  if (payroll.overtimePay > 0) {
    doc.text(`Overtime Pay: $${payroll.overtimePay.toFixed(2)}`);
  }
  
  doc.text(`Gross Salary: $${payroll.grossSalary.toFixed(2)}`, { bold: true });
  doc.moveDown();
  
  // Deductions
  doc.fontSize(14).text('Deductions', { underline: true });
  doc.fontSize(10);
  doc.text(`Tax: $${payroll.deductions.tax.toFixed(2)}`);
  doc.text(`Provident Fund: $${payroll.deductions.providentFund.toFixed(2)}`);
  doc.text(`Insurance: $${payroll.deductions.insurance.toFixed(2)}`);
  
  if (payroll.deductions.loan > 0) {
    doc.text(`Loan: $${payroll.deductions.loan.toFixed(2)}`);
  }
  
  doc.text(`Total Deductions: $${payroll.totalDeductions.toFixed(2)}`, { bold: true });
  doc.moveDown();
  
  // Net salary
  doc.fontSize(16).text(`Net Salary: $${payroll.netSalary.toFixed(2)}`, { bold: true });
  
  doc.end();
  
  return doc;
}

module.exports = router;