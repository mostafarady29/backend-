const express = require('express');
const { getPool, sql } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.post('/search', authenticateToken, async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required',
        data: null,
      });
    }

    const researcherId = req.user.userId;
    const role = req.user.role;

    if (role !== 'Researcher') {
      return res.status(200).json({
        success: true,
        message: 'Search performed but not recorded (user is not a researcher)',
        data: null,
      });
    }

    const pool = await getPool();

    await pool
      .request()
      .input('researcherId', sql.Int, researcherId)
      .input('query', sql.NVarChar(300), query.trim())
      .input('searchDate', sql.Date, new Date())
      .query(`
        INSERT INTO Search (Researcher_ID, Query, Search_Date)
        VALUES (@researcherId, @query, @searchDate)
      `);

    res.status(201).json({
      success: true,
      message: 'Search recorded successfully',
      data: null,
    });
  } catch (error) {
    console.error('Record search error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record search',
      data: null,
    });
  }
});

router.get('/searches/user/:userId', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    if (req.user.userId !== userId && req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        data: null,
      });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('userId', sql.Int, userId)
      .input('offset', sql.Int, offset)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT Search_ID, Query, Search_Date
        FROM Search
        WHERE Researcher_ID = @userId
        ORDER BY Search_Date DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const countResult = await pool
      .request()
      .input('userId', sql.Int, userId)
      .query('SELECT COUNT(*) as total FROM Search WHERE Researcher_ID = @userId');

    const total = countResult.recordset[0].total;

    res.json({
      success: true,
      message: 'Search history retrieved successfully',
      data: {
        searches: result.recordset,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Get search history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve search history',
      data: null,
    });
  }
});

router.post('/downloads', authenticateToken, async (req, res) => {
  try {
    const { paperId } = req.body;
    const researcherId = req.user.userId;

    if (!paperId) {
      return res.status(400).json({
        success: false,
        message: 'Paper ID is required',
        data: null,
      });
    }

    const pool = await getPool();
    const researcherCheck = await pool
      .request()
      .input('researcherId', sql.Int, researcherId)
      .query('SELECT Researcher_ID FROM Researcher WHERE Researcher_ID = @researcherId');

    if (researcherCheck.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'User is not a researcher',
        data: null,
      });
    }

    const result = await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .input('researcherId', sql.Int, researcherId)
      .input('downloadDate', sql.Date, new Date())
      .query(`
        INSERT INTO Download (Paper_ID, Researcher_ID, Download_Date)
        VALUES (@paperId, @researcherId, @downloadDate);
        SELECT SCOPE_IDENTITY() as Download_ID
      `);

    res.status(201).json({
      success: true,
      message: 'Download recorded successfully',
      data: { downloadId: result.recordset[0].Download_ID },
    });
  } catch (error) {
    console.error('Record download error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record download',
      data: null,
    });
  }
});

router.get('/downloads/user/:userId', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    if (req.user.userId !== userId && req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        data: null,
      });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('userId', sql.Int, userId)
      .input('offset', sql.Int, offset)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT d.Download_ID, d.Download_Date, p.Paper_ID, p.Title, p.Abstract, f.Field_Name
        FROM Download d
        INNER JOIN Paper p ON d.Paper_ID = p.Paper_ID
        LEFT JOIN Field f ON p.Field_ID = f.Field_ID
        WHERE d.Researcher_ID = @userId
        ORDER BY d.Download_Date DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const countResult = await pool
      .request()
      .input('userId', sql.Int, userId)
      .query('SELECT COUNT(*) as total FROM Download WHERE Researcher_ID = @userId');

    const total = countResult.recordset[0].total;

    res.json({
      success: true,
      message: 'Download history retrieved successfully',
      data: {
        downloads: result.recordset,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Get download history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve download history',
      data: null,
    });
  }
});

router.post('/reviews', authenticateToken, async (req, res) => {
  try {
    const { paperId, rating, comment } = req.body;
    const researcherId = req.user.userId;

    if (!paperId || !rating) {
      return res.status(400).json({
        success: false,
        message: 'Paper ID and rating are required',
        data: null,
      });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5',
        data: null,
      });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .input('researcherId', sql.Int, researcherId)
      .input('rating', sql.Int, rating)
      .input('reviewDate', sql.Date, new Date())
      .query(`
        INSERT INTO Review (Paper_ID, Researcher_ID, Rating, Review_Date)
        VALUES (@paperId, @researcherId, @rating, @reviewDate);
        SELECT SCOPE_IDENTITY() as Review_ID
      `);

    res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      data: { reviewId: result.recordset[0].Review_ID },
    });
  } catch (error) {
    console.error('Submit review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit review',
      data: null,
    });
  }
});

router.get('/reviews/paper/:paperId', async (req, res) => {
  try {
    const paperId = req.params.paperId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const pool = await getPool();
    const result = await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .input('offset', sql.Int, offset)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT r.Review_ID, r.Rating, r.Review_Date, u.Name as Reviewer_Name
        FROM Review r
        INNER JOIN [User] u ON r.Researcher_ID = u.User_ID
        WHERE r.Paper_ID = @paperId
        ORDER BY r.Review_Date DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const countResult = await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .query('SELECT COUNT(*) as total FROM Review WHERE Paper_ID = @paperId');

    const total = countResult.recordset[0].total;

    res.json({
      success: true,
      message: 'Reviews retrieved successfully',
      data: {
        reviews: result.recordset,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve reviews',
      data: null,
    });
  }
});

router.put('/reviews/:id', authenticateToken, async (req, res) => {
  try {
    const reviewId = req.params.id;
    const { rating } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Valid rating (1-5) is required',
        data: null,
      });
    }

    const pool = await getPool();
    const reviewCheck = await pool
      .request()
      .input('reviewId', sql.Int, reviewId)
      .query('SELECT Researcher_ID FROM Review WHERE Review_ID = @reviewId');

    if (reviewCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Review not found',
        data: null,
      });
    }

    if (reviewCheck.recordset[0].Researcher_ID !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only update your own reviews',
        data: null,
      });
    }

    await pool
      .request()
      .input('reviewId', sql.Int, reviewId)
      .input('rating', sql.Int, rating)
      .query('UPDATE Review SET Rating = @rating WHERE Review_ID = @reviewId');

    res.json({
      success: true,
      message: 'Review updated successfully',
      data: null,
    });
  } catch (error) {
    console.error('Update review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update review',
      data: null,
    });
  }
});

router.delete('/reviews/:id', authenticateToken, async (req, res) => {
  try {
    const reviewId = req.params.id;

    const pool = await getPool();
    const reviewCheck = await pool
      .request()
      .input('reviewId', sql.Int, reviewId)
      .query('SELECT Researcher_ID FROM Review WHERE Review_ID = @reviewId');

    if (reviewCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Review not found',
        data: null,
      });
    }

    if (reviewCheck.recordset[0].Researcher_ID !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own reviews',
        data: null,
      });
    }

    await pool
      .request()
      .input('reviewId', sql.Int, reviewId)
      .query('DELETE FROM Review WHERE Review_ID = @reviewId');

    res.json({
      success: true,
      message: 'Review deleted successfully',
      data: null,
    });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete review',
      data: null,
    });
  }
});

module.exports = router;