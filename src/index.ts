import express from 'express';
import cors from 'cors';
import CBERouter from './routes/verifyCBERoute';
import telebirrRouter from './routes/verifyTelebirrRoute';
import logger from './utils/logger';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ✅ Attach router to this path
app.use('/verify-cbe', CBERouter);
app.use('/verify-telebirr', telebirrRouter);

app.listen(PORT, () => {
    logger.info(`🚀 Server running at http://localhost:${PORT}`);
});
