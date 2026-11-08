/**
 * routes/intake.routes.ts
 *
 * All intake routes require authentication AND the ESTIMATOR role.
 * Uploaded files are held in memory only (Multer memoryStorage, 10 MB limit).
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { authorizeRoles } from '../middleware/authorizeRoles';
import { MAX_UPLOAD_BYTES } from '../services/intake/fileValidation.service';
import {
  getIntakeStatusHandler,
  emailIntakeHandler,
  uploadIntakeHandler,
  getIntakeDraftHandler,
  patchIntakeFieldsHandler,
  commitIntakeDraftHandler,
} from '../controllers/intake.controller';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

function uploadSingleFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: 'File exceeds the 10 MB limit.',
          code: 'FILE_TOO_LARGE',
        });
        return;
      }
      res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

router.use(authenticate);
router.use(authorizeRoles('ESTIMATOR'));

router.get('/status', getIntakeStatusHandler);
router.post('/email', emailIntakeHandler);
router.post('/upload', uploadSingleFile, uploadIntakeHandler);
router.get('/:id', getIntakeDraftHandler);
router.patch('/:id/fields', patchIntakeFieldsHandler);
router.post('/:id/commit', commitIntakeDraftHandler);

export default router;

