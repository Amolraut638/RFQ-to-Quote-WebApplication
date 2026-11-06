/**
 * middleware/authorizeRoles.ts
 *
 * Role-based access control middleware.
 * Always used AFTER authenticate — relies on req.user being set.
 *
 * Usage:  router.post('/approve', authenticate, authorizeRoles('SALES_HEAD'), handler)
 */

import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../models/User';

export function authorizeRoles(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}.`,
      });
      return;
    }

    next();
  };
}

