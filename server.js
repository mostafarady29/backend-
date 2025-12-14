const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();
const { getPool, closePool } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const papersRoutes = require('./routes/papers');
const authorsRoutes = require('./routes/authors');
const fieldsRoutes = require('./routes/fields');
const interactionsRoutes = require('./routes/interactions');
const statisticsRoutes = require('./routes/statistics');
const aiRoutes = require('./routes/ai');
const usersRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const chatSessionsRoutes = require('./routes/chat-sessions');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// Serve static files for uploaded papers
app.use('/uploads', express.static('uploads'));

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    data: null,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/papers', papersRoutes);
app.use('/api/authors', authorsRoutes);
app.use('/api/fields', fieldsRoutes);
app.use('/api/interactions', interactionsRoutes);
app.use('/api/statistics', statisticsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/chat', chatSessionsRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    data: null,
  });
});

app.use(errorHandler);

const server = app.listen(PORT, async () => {
  try {
    await getPool();
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Database connected');
    console.log('\n' + '='.repeat(80));
    console.log('AVAILABLE API ENDPOINTS:');
    console.log('='.repeat(80) + '\n');

    // Authentication Routes
    console.log('[AUTHENTICATION]');
    console.log('  POST   /api/auth/register');
    console.log('  POST   /api/auth/login');
    console.log('  GET    /api/auth/me\n');

    // Papers Routes
    console.log('[PAPERS]');
    console.log('  GET    /api/papers');
    console.log('  GET    /api/papers/:id');
    console.log('  GET    /api/papers/search/:query\n');

    // Authors Routes
    console.log('[AUTHORS]');
    console.log('  GET    /api/authors');
    console.log('  GET    /api/authors/:id\n');

    // Fields Routes
    console.log('[FIELDS]');
    console.log('  GET    /api/fields');
    console.log('  POST   /api/fields');
    console.log('  PUT    /api/fields/:id');
    console.log('  DELETE /api/fields/:id\n');

    // Interactions Routes
    console.log('[INTERACTIONS]');
    console.log('  POST   /api/interactions/download/:paperId');
    console.log('  POST   /api/interactions/review');
    console.log('  GET    /api/interactions/reviews/:paperId\n');

    // Statistics Routes
    console.log('[STATISTICS]');
    console.log('  GET    /api/statistics/overview');
    console.log('  GET    /api/statistics/papers');
    console.log('  GET    /api/statistics/users\n');

    // AI/Recommendations Routes
    console.log('[AI & RECOMMENDATIONS]');
    console.log('  POST   /api/ai/recommend');
    console.log('  GET    /api/ai/for-you\n');

    // Users Routes
    console.log('[USERS]');
    console.log('  GET    /api/users/profile');
    console.log('  PUT    /api/users/profile\n');

    // Admin Routes
    console.log('[ADMIN]');
    console.log('  GET    /api/admin/statistics');
    console.log('  POST   /api/admin/papers');
    console.log('  GET    /api/admin/papers');
    console.log('  PUT    /api/admin/papers/:id');
    console.log('  DELETE /api/admin/papers/:id');
    console.log('  GET    /api/admin/users');
    console.log('  POST   /api/admin/users');
    console.log('  PUT    /api/admin/users/:id/role');
    console.log('  DELETE /api/admin/users/:id\n');

    // Chat Sessions Routes
    console.log('[CHAT SESSIONS]');
    console.log('  GET    /api/chat/sessions');
    console.log('  GET    /api/chat/sessions/:sessionId');
    console.log('  POST   /api/chat/sessions');
    console.log('  PUT    /api/chat/sessions/:sessionId');
    console.log('  DELETE /api/chat/sessions/:sessionId\n');

    // Health Check
    console.log('[HEALTH]');
    console.log('  GET    /health\n');

    console.log('='.repeat(80));
    console.log(`Server ready at http://localhost:${PORT}`);
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  server.close(async () => {
    await closePool();
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;