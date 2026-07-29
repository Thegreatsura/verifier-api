import { Router, type Request, type Response } from 'express';
import { statusMonitorSignature } from '../middleware/statusMonitorSignature';
import {
  getStatusCapabilities,
  runStatusProviderProbe,
} from '../services/statusProbeService';
import {
  STATUS_PROVIDERS,
  type StatusProvider,
} from '../types/statusProbe';

const router = Router();
const allowedProviders = new Set<string>(STATUS_PROVIDERS);

router.use(statusMonitorSignature);

router.post(
  '/probe/:provider',
  async (req: Request<{ provider: string }>, res: Response): Promise<void> => {
    const provider = req.params.provider;
    if (!allowedProviders.has(provider)) {
      res.status(404).json({ error: 'Unknown status provider.' });
      return;
    }

    const result = await runStatusProviderProbe(provider as StatusProvider);
    res.status(200).json(result);
  },
);

router.get('/capabilities', (_req: Request, res: Response): void => {
  res.json(getStatusCapabilities());
});

export default router;
