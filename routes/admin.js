/**
 * routes/admin.js
 * Admin-only routes for managing research papers
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getPool, sql } = require('../config/database');
const { authenticateToken, authorizeAdmin } = require('../middleware/auth');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../uploads/papers');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'paper-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new Error('Only PDF files are allowed'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Apply authentication and admin authorization to all routes
router.use(authenticateToken);
router.use(authorizeAdmin);

/**
 * POST /api/admin/papers
 * Upload a new research paper
 */
router.post('/papers', upload.single('pdfFile'), async (req, res) => {
    try {
        const {
            title,
            abstract,
            publicationDate,
            fieldId,
            authors, // JSON string: [{ firstName, lastName, email, country }]
            keywords // JSON string: ["keyword1", "keyword2"]
        } = req.body;

        // Validation
        if (!title || !abstract || !fieldId) {
            // Delete uploaded file if validation fails
            if (req.file) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(400).json({
                success: false,
                message: 'Title, abstract, and field are required',
                data: null
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'PDF file is required',
                data: null
            });
        }

        const pool = await getPool();
        const adminId = req.user.userId;

        // Ensure Admin record exists (auto-fix for existing users)
        const adminCheck = await pool
            .request()
            .input('adminId', sql.Int, adminId)
            .query('SELECT Admin_ID FROM Admin WHERE Admin_ID = @adminId');

        if (adminCheck.recordset.length === 0) {
            // Create Admin record if it doesn't exist
            await pool
                .request()
                .input('adminId', sql.Int, adminId)
                .query('INSERT INTO Admin (Admin_ID) VALUES (@adminId)');
        }

        // Get relative path for storage
        const relativePath = `/uploads/papers/${req.file.filename}`;

        // Insert paper
        const paperResult = await pool
            .request()
            .input('title', sql.NVarChar, title)
            .input('abstract', sql.NVarChar, abstract)
            .input('publicationDate', sql.Date, publicationDate || new Date())
            .input('path', sql.NVarChar, relativePath)
            .input('fieldId', sql.Int, parseInt(fieldId))
            .input('adminId', sql.Int, adminId)
            .query(`
        INSERT INTO Paper (Title, Abstract, Publication_Date, Path, Field_ID, Admin_ID)
        VALUES (@title, @abstract, @publicationDate, @path, @fieldId, @adminId);
        SELECT SCOPE_IDENTITY() as Paper_ID;
      `);

        const paperId = paperResult.recordset[0].Paper_ID;

        // Insert authors if provided
        if (authors) {
            const authorsList = JSON.parse(authors);
            for (const author of authorsList) {
                // Check if author exists
                let authorResult = await pool
                    .request()
                    .input('email', sql.NVarChar, author.email)
                    .query('SELECT Author_ID FROM Author WHERE Email = @email');

                let authorId;
                if (authorResult.recordset.length > 0) {
                    authorId = authorResult.recordset[0].Author_ID;
                } else {
                    // Create new author
                    const newAuthorResult = await pool
                        .request()
                        .input('email', sql.NVarChar, author.email)
                        .input('firstName', sql.NVarChar, author.firstName)
                        .input('lastName', sql.NVarChar, author.lastName)
                        .input('country', sql.NVarChar, author.country || null)
                        .query(`
              INSERT INTO Author (Email, First_Name, Last_Name, Country)
              VALUES (@email, @firstName, @lastName, @country);
              SELECT SCOPE_IDENTITY() as Author_ID;
            `);
                    authorId = newAuthorResult.recordset[0].Author_ID;
                }

                // Link author to paper
                await pool
                    .request()
                    .input('authorId', sql.Int, authorId)
                    .input('paperId', sql.Int, paperId)
                    .input('writeDate', sql.Date, publicationDate || new Date())
                    .query(`
            INSERT INTO Author_Paper (Author_ID, Paper_ID, Write_Date)
            VALUES (@authorId, @paperId, @writeDate);
          `);
            }
        }

        // Insert keywords if provided
        if (keywords) {
            const keywordsList = JSON.parse(keywords);
            if (keywordsList.length > 0) {
                await pool
                    .request()
                    .input('paperId', sql.Int, paperId)
                    .input('keywords', sql.NVarChar, keywordsList.join(', '))
                    .query(`
            INSERT INTO Paper_Keywords (Paper_ID, Keywords)
            VALUES (@paperId, @keywords);
          `);
            }
        }

        res.status(201).json({
            success: true,
            message: 'Paper uploaded successfully',
            data: {
                paperId,
                title,
                path: relativePath
            }
        });

    } catch (error) {
        console.error('Upload paper error:', error);

        // Delete uploaded file on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
            success: false,
            message: 'Failed to upload paper',
            error: error.message,
            data: null
        });
    }
});

/**
 * GET /api/admin/papers
 * Get all papers with pagination (admin view)
 */
router.get('/papers', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const pool = await getPool();

        // Get total count
        const countResult = await pool
            .request()
            .query('SELECT COUNT(*) as total FROM Paper');

        const total = countResult.recordset[0].total;

        // Get papers with field and admin info
        const papersResult = await pool
            .request()
            .input('limit', sql.Int, limit)
            .input('offset', sql.Int, offset)
            .query(`
        SELECT 
          p.Paper_ID,
          p.Title,
          p.Abstract,
          p.Publication_Date,
          p.Path,
          f.Field_Name,
          u.Name as Admin_Name,
          (SELECT COUNT(*) FROM Download d WHERE d.Paper_ID = p.Paper_ID) as Download_Count,
          (SELECT COUNT(*) FROM Review r WHERE r.Paper_ID = p.Paper_ID) as Review_Count
        FROM Paper p
        LEFT JOIN Field f ON p.Field_ID = f.Field_ID
        LEFT JOIN Admin a ON p.Admin_ID = a.Admin_ID
        LEFT JOIN [User] u ON a.Admin_ID = u.User_ID
        ORDER BY p.Publication_Date DESC
        OFFSET @offset ROWS
        FETCH NEXT @limit ROWS ONLY
      `);

        res.json({
            success: true,
            message: 'Papers retrieved successfully',
            data: {
                papers: papersResult.recordset,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit)
                }
            }
        });

    } catch (error) {
        console.error('Get papers error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve papers',
            data: null
        });
    }
});

/**
 * DELETE /api/admin/papers/:id
 * Delete a paper
 */
router.delete('/papers/:id', async (req, res) => {
    try {
        const paperId = parseInt(req.params.id);
        const pool = await getPool();

        // Get paper info to delete file
        const paperResult = await pool
            .request()
            .input('paperId', sql.Int, paperId)
            .query('SELECT Path FROM Paper WHERE Paper_ID = @paperId');

        if (paperResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Paper not found',
                data: null
            });
        }

        const paperPath = paperResult.recordset[0].Path;

        // Delete related records first (due to foreign keys)
        await pool
            .request()
            .input('paperId', sql.Int, paperId)
            .query('DELETE FROM Paper_Keywords WHERE Paper_ID = @paperId');

        await pool
            .request()
            .input('paperId', sql.Int, paperId)
            .query('DELETE FROM Author_Paper WHERE Paper_ID = @paperId');

        await pool
            .request()
            .input('paperId', sql.Int, paperId)
            .query('DELETE FROM Download WHERE Paper_ID = @paperId');

        await pool
            .request()
            .input('paperId', sql.Int, paperId)
            .query('DELETE FROM Review WHERE Paper_ID = @paperId');

        // Delete paper record
        await pool
            .request()
            .input('paperId', sql.Int, paperId)
            .query('DELETE FROM Paper WHERE Paper_ID = @paperId');

        // Delete physical file
        if (paperPath) {
            const fullPath = path.join(__dirname, '..', paperPath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        }

        res.json({
            success: true,
            message: 'Paper deleted successfully',
            data: null
        });

    } catch (error) {
        console.error('Delete paper error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete paper',
            data: null
        });
    }
});

/**
 * PUT /api/admin/papers/:id
 * Update paper metadata
 */
router.put('/papers/:id', async (req, res) => {
    try {
        const paperId = parseInt(req.params.id);
        const { title, abstract, publicationDate, fieldId } = req.body;

        const pool = await getPool();

        // Check if paper exists
        const checkResult = await pool
            .request()
            .input('paperId', sql.Int, paperId)
            .query('SELECT Paper_ID FROM Paper WHERE Paper_ID = @paperId');

        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Paper not found',
                data: null
            });
        }

        // Update paper
        await pool
            .request()
            .input('paperId', sql.Int, paperId)
            .input('title', sql.NVarChar, title)
            .input('abstract', sql.NVarChar, abstract)
            .input('publicationDate', sql.Date, publicationDate)
            .input('fieldId', sql.Int, parseInt(fieldId))
            .query(`
        UPDATE Paper
        SET Title = @title,
            Abstract = @abstract,
            Publication_Date = @publicationDate,
            Field_ID = @fieldId
        WHERE Paper_ID = @paperId
      `);

        res.json({
            success: true,
            message: 'Paper updated successfully',
            data: { paperId }
        });

    } catch (error) {
        console.error('Update paper error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update paper',
            data: null
        });
    }
});

/**
 * GET /api/admin/users
 * Get all users with pagination (admin view)
 */
router.get('/users', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const searchQuery = req.query.search || '';

        const pool = await getPool();

        let whereClause = '';
        let searchInput = null;

        if (searchQuery) {
            whereClause = `WHERE Name LIKE @search OR Email LIKE @search`;
            searchInput = `%${searchQuery}%`;
        }

        // Get total count
        const countQuery = `SELECT COUNT(*) as total FROM [User] ${whereClause}`;
        const countRequest = pool.request();
        if (searchInput) {
            countRequest.input('search', sql.NVarChar, searchInput);
        }
        const countResult = await countRequest.query(countQuery);
        const total = countResult.recordset[0].total;

        // Get users
        const usersQuery = `
            SELECT 
                User_ID,
                Name,
                Email,
                Role
            FROM [User]
            ${whereClause}
            ORDER BY Name
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `;

        const usersRequest = pool.request()
            .input('limit', sql.Int, limit)
            .input('offset', sql.Int, offset);

        if (searchInput) {
            usersRequest.input('search', sql.NVarChar, searchInput);
        }

        const usersResult = await usersRequest.query(usersQuery);

        // Get role counts (always from full dataset, not filtered)
        const roleCountsResult = await pool
            .request()
            .query(`
                SELECT 
                    Role,
                    COUNT(*) as Count
                FROM [User]
                GROUP BY Role
            `);

        const roleCounts = {};
        roleCountsResult.recordset.forEach(row => {
            roleCounts[row.Role] = row.Count;
        });

        res.json({
            success: true,
            message: 'Users retrieved successfully',
            data: {
                users: usersResult.recordset,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit)
                },
                roleCounts
            }
        });

    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve users',
            data: null
        });
    }
});

/**
 * PUT /api/admin/users/:id/role
 * Update user role
 */
router.put('/users/:id/role', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { role } = req.body;
        const adminId = req.user.userId;

        // Validate role
        if (!role || !['Admin', 'Researcher'].includes(role)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid role. Must be Admin or Researcher',
                data: null
            });
        }

        // Prevent admin from changing their own role
        if (userId === adminId) {
            return res.status(403).json({
                success: false,
                message: 'Cannot change your own role',
                data: null
            });
        }

        const pool = await getPool();

        // Check if user exists
        const userResult = await pool
            .request()
            .input('userId', sql.Int, userId)
            .query('SELECT User_ID, Role FROM [User] WHERE User_ID = @userId');

        if (userResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
                data: null
            });
        }

        const currentRole = userResult.recordset[0].Role;

        // If role is not changing, return success
        if (currentRole === role) {
            return res.json({
                success: true,
                message: 'Role unchanged',
                data: { userId, role }
            });
        }

        // Update user role
        await pool
            .request()
            .input('userId', sql.Int, userId)
            .input('role', sql.NVarChar, role)
            .query('UPDATE [User] SET Role = @role WHERE User_ID = @userId');

        // Handle role-specific table changes
        if (role === 'Admin') {
            // Check if Admin record exists
            const adminCheck = await pool
                .request()
                .input('adminId', sql.Int, userId)
                .query('SELECT Admin_ID FROM Admin WHERE Admin_ID = @adminId');

            if (adminCheck.recordset.length === 0) {
                // Create Admin record
                await pool
                    .request()
                    .input('adminId', sql.Int, userId)
                    .query('INSERT INTO Admin (Admin_ID) VALUES (@adminId)');
            }

            // Remove from Researcher if exists
            await pool
                .request()
                .input('researcherId', sql.Int, userId)
                .query('DELETE FROM Researcher WHERE Researcher_ID = @researcherId');

        } else if (role === 'Researcher') {
            // Check if Researcher record exists
            const researcherCheck = await pool
                .request()
                .input('researcherId', sql.Int, userId)
                .query('SELECT Researcher_ID FROM Researcher WHERE Researcher_ID = @researcherId');

            if (researcherCheck.recordset.length === 0) {
                // Create Researcher record
                const joinDate = new Date();
                await pool
                    .request()
                    .input('researcherId', sql.Int, userId)
                    .input('joinDate', sql.Date, joinDate)
                    .query(`
                        INSERT INTO Researcher (Researcher_ID, Affiliation, Specialization, Join_Date)
                        VALUES (@researcherId, NULL, NULL, @joinDate)
                    `);
            }

            // Remove from Admin if exists
            await pool
                .request()
                .input('adminId', sql.Int, userId)
                .query('DELETE FROM Admin WHERE Admin_ID = @adminId');
        }

        res.json({
            success: true,
            message: 'User role updated successfully',
            data: {
                userId,
                previousRole: currentRole,
                newRole: role
            }
        });

    } catch (error) {
        console.error('Update user role error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update user role',
            data: null,
            error: error.message
        });
    }
});

/**
 * DELETE /api/admin/users/:id
 * Delete a user
 */
router.delete('/users/:id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const adminId = req.user.userId;

        if (isNaN(userId) || userId < 1) {
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID',
                data: null
            });
        }

        // Prevent admin from deleting themselves
        if (userId === adminId) {
            return res.status(403).json({
                success: false,
                message: 'Cannot delete your own account',
                data: null
            });
        }

        const pool = await getPool();

        // Check if user exists
        const userResult = await pool
            .request()
            .input('userId', sql.Int, userId)
            .query('SELECT User_ID, Role FROM [User] WHERE User_ID = @userId');

        if (userResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
                data: null
            });
        }

        const userRole = userResult.recordset[0].Role;

        // Delete related records first to avoid foreign key conflicts
        if (userRole === 'Researcher') {
            // Delete Search records
            await pool
                .request()
                .input('researcherId', sql.Int, userId)
                .query('DELETE FROM Search WHERE Researcher_ID = @researcherId');

            // Delete Reviews
            await pool
                .request()
                .input('researcherId', sql.Int, userId)
                .query('DELETE FROM Review WHERE Researcher_ID = @researcherId');

            // Delete Downloads
            await pool
                .request()
                .input('researcherId', sql.Int, userId)
                .query('DELETE FROM Download WHERE Researcher_ID = @researcherId');

            // Delete Researcher record
            await pool
                .request()
                .input('researcherId', sql.Int, userId)
                .query('DELETE FROM Researcher WHERE Researcher_ID = @researcherId');
        } else if (userRole === 'Admin') {
            // Delete Papers uploaded by this admin (this will cascade to other tables)
            await pool
                .request()
                .input('adminId', sql.Int, userId)
                .query('DELETE FROM Paper WHERE Admin_ID = @adminId');

            // Delete Admin record
            await pool
                .request()
                .input('adminId', sql.Int, userId)
                .query('DELETE FROM Admin WHERE Admin_ID = @adminId');
        }

        // Delete user record
        await pool
            .request()
            .input('userId', sql.Int, userId)
            .query('DELETE FROM [User] WHERE User_ID = @userId');

        res.json({
            success: true,
            message: 'User deleted successfully',
            data: null
        });

    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete user',
            data: null,
            error: error.message
        });
    }
});

/**
 * POST /api/admin/users
 * Create a new user
 */
router.post('/users', async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        // Validation
        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Name, email, and password are required',
                data: null
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters',
                data: null
            });
        }

        if (!role || !['Admin', 'Researcher'].includes(role)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid role. Must be Admin or Researcher',
                data: null
            });
        }

        const pool = await getPool();

        // Check if email already exists
        const checkResult = await pool
            .request()
            .input('email', sql.NVarChar, email)
            .query('SELECT User_ID FROM [User] WHERE Email = @email');

        if (checkResult.recordset.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Email already registered',
                data: null
            });
        }

        // Hash password
        const bcrypt = require('bcryptjs');
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const result = await pool
            .request()
            .input('name', sql.NVarChar, name)
            .input('email', sql.NVarChar, email)
            .input('password', sql.NVarChar, hashedPassword)
            .input('role', sql.NVarChar, role)
            .query(`
                INSERT INTO [User] (Name, Email, Password, Role)
                VALUES (@name, @email, @password, @role);
                SELECT SCOPE_IDENTITY() as User_ID
            `);

        const newUserId = result.recordset[0].User_ID;

        // Create role-specific record
        if (role === 'Admin') {
            await pool
                .request()
                .input('adminId', sql.Int, newUserId)
                .query('INSERT INTO Admin (Admin_ID) VALUES (@adminId)');
        } else if (role === 'Researcher') {
            const joinDate = new Date();
            await pool
                .request()
                .input('researcherId', sql.Int, newUserId)
                .input('joinDate', sql.Date, joinDate)
                .query(`
                    INSERT INTO Researcher (Researcher_ID, Affiliation, Specialization, Join_Date)
                    VALUES (@researcherId, NULL, NULL, @joinDate)
                `);
        }

        res.status(201).json({
            success: true,
            message: 'User created successfully',
            data: {
                userId: newUserId,
                name,
                email,
                role
            }
        });

    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create user',
            data: null,
            error: error.message
        });
    }
});

module.exports = router;

