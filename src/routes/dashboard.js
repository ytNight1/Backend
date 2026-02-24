const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/dashboard/admin
router.get('/admin', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [
      totalUsers, totalStudents, totalTeachers, totalClasses,
      activeAssignments, totalSubmissions, recentActivity,
      xpRanking, submissionsByType
    ] = await Promise.all([
      db.queryOne('SELECT COUNT(*)::int as count FROM users WHERE is_active = TRUE'),
      db.queryOne('SELECT COUNT(*)::int as count FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = "student"'),
      db.queryOne('SELECT COUNT(*)::int as count FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = "teacher"'),
      db.queryOne('SELECT COUNT(*)::int as count FROM classes WHERE is_active = TRUE'),
      db.queryOne('SELECT COUNT(*)::int as count FROM assignments WHERE status = 'published''),
      db.queryOne('SELECT COUNT(*)::int as count FROM submissions'),
      db.query(`SELECT al.action, al.created_at, u.display_name
                FROM activity_logs al LEFT JOIN users u ON al.user_id = u.id
                ORDER BY al.created_at DESC LIMIT 10`),
      db.query(`SELECT u.display_name, u.minecraft_username, xp.total_xp, xp.level
                FROM student_xp xp JOIN users u ON xp.student_id = u.id
                ORDER BY xp.total_xp DESC LIMIT 10`),
      db.query(`SELECT type, COUNT(*)::int as count FROM assignments GROUP BY type`)
    ]);

    res.json({
      stats: {
        totalUsers: totalUsers.count,
        totalStudents: totalStudents.count,
        totalTeachers: totalTeachers.count,
        totalClasses: totalClasses.count,
        activeAssignments: activeAssignments.count,
        totalSubmissions: totalSubmissions.count
      },
      recentActivity,
      xpRanking,
      submissionsByType
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar dashboard admin' });
  }
});

// GET /api/dashboard/secretary
router.get('/secretary', authenticate, authorize('admin', 'secretary'), async (req, res) => {
  try {
    const [classes, recentUsers, gradeOverview] = await Promise.all([
      db.query(`
        SELECT c.*, sy.name as year_name,
               (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.id) as student_count,
               (SELECT COUNT(*) FROM class_teachers ct WHERE ct.class_id = c.id) as teacher_count
        FROM classes c JOIN school_years sy ON c.school_year_id = sy.id
        WHERE c.is_active = TRUE ORDER BY c.name
      `),
      db.query(`
        SELECT u.id, u.username, u.display_name, u.email, r.name as role, u.created_at
        FROM users u JOIN roles r ON u.role_id = r.id
        ORDER BY u.created_at DESC LIMIT 10
      `),
      db.query(`
        SELECT sy.name as year_name, s.name as subject_name,
               ROUND(AVG(g.grade), 2) as avg_grade, COUNT(g.id) as grade_count
        FROM grades g
        JOIN classes c ON g.class_id = c.id
        JOIN school_years sy ON c.school_year_id = sy.id
        JOIN subjects s ON g.subject_id = s.id
        WHERE g.academic_year = EXTRACT(YEAR FROM NOW())
        GROUP BY sy.id, s.id ORDER BY sy.year_number, s.name
      `)
    ]);

    res.json({ classes, recentUsers, gradeOverview });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar dashboard secretaria' });
  }
});

// GET /api/dashboard/teacher
router.get('/teacher', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const teacherId = req.user.id;

    const [myClasses, myAssignments, pendingGrades, classPerformance] = await Promise.all([
      db.query(`
        SELECT DISTINCT c.*, sy.name as year_name, s.name as subject_name
        FROM class_teachers ct
        JOIN classes c ON ct.class_id = c.id
        JOIN school_years sy ON c.school_year_id = sy.id
        JOIN subjects s ON ct.subject_id = s.id
        WHERE ct.teacher_id = ? AND c.is_active = TRUE
      `, [teacherId]),
      db.query(`
        SELECT a.*, c.name as class_name, s.name as subject_name,
               COUNT(DISTINCT sub.id) as submission_count,
               AVG(sub.score) as avg_score
        FROM assignments a
        JOIN classes c ON a.class_id = c.id
        JOIN subjects s ON a.subject_id = s.id
        LEFT JOIN submissions sub ON sub.assignment_id = a.id
        WHERE a.teacher_id = ?
        GROUP BY a.id ORDER BY a.created_at DESC LIMIT 20
      `, [teacherId]),
      db.query(`
        SELECT s.id, u.display_name, u.minecraft_username, a.title, s.submitted_at
        FROM submissions s
        JOIN users u ON s.student_id = u.id
        JOIN assignments a ON s.assignment_id = a.id
        WHERE a.teacher_id = ? AND s.status = 'submitted' AND a.type = 'open'
        ORDER BY s.submitted_at ASC LIMIT 10
      `, [teacherId]),
      db.query(`
        SELECT c.name as class_name, s.name as subject_name,
               ROUND(AVG(sub.score), 2) as avg_score,
               COUNT(sub.id) as total_submissions
        FROM assignments a
        JOIN classes c ON a.class_id = c.id
        JOIN subjects s ON a.subject_id = s.id
        LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.status IN ('submitted','graded')
        WHERE a.teacher_id = ?
        GROUP BY a.class_id, a.subject_id
      `, [teacherId])
    ]);

    res.json({ myClasses, myAssignments, pendingGrades, classPerformance });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar dashboard professor' });
  }
});

// GET /api/dashboard/student
router.get('/student', authenticate, authorize('student'), async (req, res) => {
  try {
    const studentId = req.user.id;

    const [xpData, myClasses, pendingAssignments, recentGrades, achievements, ranking] = await Promise.all([
      db.queryOne('SELECT * FROM student_xp WHERE student_id = ?', [studentId]),
      db.query(`
        SELECT c.name as class_name, sy.name as year_name, s.name as subject_name, sub.name as subject
        FROM class_students cs
        JOIN classes c ON cs.class_id = c.id
        JOIN school_years sy ON c.school_year_id = sy.id
        LEFT JOIN class_teachers ct ON ct.class_id = c.id
        LEFT JOIN subjects sub ON ct.subject_id = sub.id
        WHERE cs.student_id = ? AND c.is_active = TRUE
      `, [studentId]),
      db.query(`
        SELECT a.id, a.title, a.type, a.xp_reward, a.ends_at, s.name as subject_name, s.color,
               c.name as class_name,
               sub.status as submission_status
        FROM assignments a
        JOIN class_students cs ON cs.class_id = a.class_id
        JOIN subjects s ON a.subject_id = s.id
        JOIN classes c ON a.class_id = c.id
        LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.student_id = ?
        WHERE cs.student_id = ? AND a.status = 'published'
        AND (sub.status IS NULL OR sub.status = 'in_progress')
        AND (a.ends_at IS NULL OR a.ends_at > NOW())
        ORDER BY a.ends_at ASC, a.created_at DESC LIMIT 10
      `, [studentId, studentId]),
      db.query(`
        SELECT g.grade, g.bimester, s.name as subject_name, s.color, g.updated_at
        FROM grades g JOIN subjects s ON g.subject_id = s.id
        WHERE g.student_id = ? AND g.academic_year = EXTRACT(YEAR FROM NOW())
        ORDER BY g.updated_at DESC LIMIT 10
      `, [studentId]),
      db.query(`
        SELECT a.name, a.description, a.icon, a.xp_reward, sa.earned_at
        FROM student_achievements sa JOIN achievements a ON sa.achievement_id = a.id
        WHERE sa.student_id = ? ORDER BY sa.earned_at DESC
      `, [studentId]),
      db.query(`
        SELECT u.display_name, xp.total_xp, xp.level,
               ROW_NUMBER() OVER (ORDER BY xp.total_xp DESC) as rank_position
        FROM student_xp xp JOIN users u ON xp.student_id = u.id
        ORDER BY xp.total_xp DESC LIMIT 10
      `)
    ]);

    const xpForNextLevel = xpData ? ((xpData.level * 1000) - xpData.total_xp) : 1000;

    res.json({
      xp: xpData,
      xpForNextLevel,
      myClasses,
      pendingAssignments,
      recentGrades,
      achievements,
      ranking
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar dashboard aluno' });
  }
});

module.exports = router;
