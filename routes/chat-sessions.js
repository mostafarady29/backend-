const express = require('express');
const { getPool, sql } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all chat sessions for the authenticated user
router.get('/sessions', authenticateToken, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool
            .request()
            .input('userId', sql.Int, req.user.userId)
            .query(`
        SELECT 
          Session_ID as id,
          Title as title,
          Created_At as createdAt,
          Updated_At as updatedAt
        FROM ChatSession
        WHERE User_ID = @userId
        ORDER BY Updated_At DESC
      `);

        res.json({
            success: true,
            message: 'Chat sessions retrieved successfully',
            data: result.recordset,
        });
    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve chat sessions',
            data: null,
        });
    }
});

// Get a specific chat session with all messages
router.get('/sessions/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const pool = await getPool();

        // Verify session belongs to user
        const sessionResult = await pool
            .request()
            .input('sessionId', sql.Int, sessionId)
            .input('userId', sql.Int, req.user.userId)
            .query(`
        SELECT 
          Session_ID as id,
          User_ID as userId,
          Title as title,
          Created_At as createdAt,
          Updated_At as updatedAt
        FROM ChatSession
        WHERE Session_ID = @sessionId AND User_ID = @userId
      `);

        if (sessionResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Chat session not found',
                data: null,
            });
        }

        // Get all messages for this session
        const messagesResult = await pool
            .request()
            .input('sessionId', sql.Int, sessionId)
            .query(`
        SELECT 
          Message_ID as id,
          Role as role,
          Content as content,
          Sources_Used as sources_used,
          Created_At as timestamp
        FROM ChatMessage
        WHERE Session_ID = @sessionId
        ORDER BY Created_At ASC
      `);

        const session = sessionResult.recordset[0];
        session.messages = messagesResult.recordset;

        res.json({
            success: true,
            message: 'Chat session retrieved successfully',
            data: session,
        });
    } catch (error) {
        console.error('Get session error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve chat session',
            data: null,
        });
    }
});

// Create a new chat session
router.post('/sessions', authenticateToken, async (req, res) => {
    try {
        const { title, messages } = req.body;
        const pool = await getPool();

        // Create the session
        const sessionResult = await pool
            .request()
            .input('userId', sql.Int, req.user.userId)
            .input('title', sql.NVarChar, title || 'New Chat')
            .query(`
        INSERT INTO ChatSession (User_ID, Title, Created_At, Updated_At)
        VALUES (@userId, @title, GETDATE(), GETDATE());
        SELECT SCOPE_IDENTITY() as Session_ID;
      `);

        const sessionId = sessionResult.recordset[0].Session_ID;

        // Insert messages if provided
        if (messages && Array.isArray(messages) && messages.length > 0) {
            for (const message of messages) {
                await pool
                    .request()
                    .input('sessionId', sql.Int, sessionId)
                    .input('role', sql.NVarChar, message.role)
                    .input('content', sql.NVarChar, message.content)
                    .input('sourcesUsed', sql.Int, message.sources_used || null)
                    .query(`
            INSERT INTO ChatMessage (Session_ID, Role, Content, Sources_Used, Created_At)
            VALUES (@sessionId, @role, @content, @sourcesUsed, GETDATE())
          `);
            }
        }

        res.status(201).json({
            success: true,
            message: 'Chat session created successfully',
            data: { sessionId, title },
        });
    } catch (error) {
        console.error('Create session error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create chat session',
            data: null,
        });
    }
});

// Update a chat session (title and/or messages)
router.put('/sessions/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { title, messages } = req.body;
        const pool = await getPool();

        // Verify session belongs to user
        const checkResult = await pool
            .request()
            .input('sessionId', sql.Int, sessionId)
            .input('userId', sql.Int, req.user.userId)
            .query('SELECT Session_ID FROM ChatSession WHERE Session_ID = @sessionId AND User_ID = @userId');

        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Chat session not found',
                data: null,
            });
        }

        // Update title if provided
        if (title) {
            await pool
                .request()
                .input('sessionId', sql.Int, sessionId)
                .input('title', sql.NVarChar, title)
                .query('UPDATE ChatSession SET Title = @title, Updated_At = GETDATE() WHERE Session_ID = @sessionId');
        }

        // Update messages if provided (delete old, insert new)
        if (messages && Array.isArray(messages)) {
            // Delete existing messages
            await pool
                .request()
                .input('sessionId', sql.Int, sessionId)
                .query('DELETE FROM ChatMessage WHERE Session_ID = @sessionId');

            // Insert new messages
            for (const message of messages) {
                await pool
                    .request()
                    .input('sessionId', sql.Int, sessionId)
                    .input('role', sql.NVarChar, message.role)
                    .input('content', sql.NVarChar, message.content)
                    .input('sourcesUsed', sql.Int, message.sources_used || null)
                    .query(`
            INSERT INTO ChatMessage (Session_ID, Role, Content, Sources_Used, Created_At)
            VALUES (@sessionId, @role, @content, @sourcesUsed, GETDATE())
          `);
            }

            // Update the session's Updated_At
            await pool
                .request()
                .input('sessionId', sql.Int, sessionId)
                .query('UPDATE ChatSession SET Updated_At = GETDATE() WHERE Session_ID = @sessionId');
        }

        res.json({
            success: true,
            message: 'Chat session updated successfully',
            data: { sessionId },
        });
    } catch (error) {
        console.error('Update session error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update chat session',
            data: null,
        });
    }
});

// Delete a chat session
router.delete('/sessions/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const pool = await getPool();

        // Verify session belongs to user
        const checkResult = await pool
            .request()
            .input('sessionId', sql.Int, sessionId)
            .input('userId', sql.Int, req.user.userId)
            .query('SELECT Session_ID FROM ChatSession WHERE Session_ID = @sessionId AND User_ID = @userId');

        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Chat session not found',
                data: null,
            });
        }

        // Delete session (messages will be cascade deleted)
        await pool
            .request()
            .input('sessionId', sql.Int, sessionId)
            .query('DELETE FROM ChatSession WHERE Session_ID = @sessionId');

        res.json({
            success: true,
            message: 'Chat session deleted successfully',
            data: null,
        });
    } catch (error) {
        console.error('Delete session error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete chat session',
            data: null,
        });
    }
});

module.exports = router;
