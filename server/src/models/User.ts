/**
 * models/User.ts
 *
 * Two roles: ESTIMATOR | SALES_HEAD
 * Passwords are hashed by pre-save hook — never stored in plaintext.
 * passwordHash is stripped from all JSON responses.
 */

import mongoose, { Document, Model, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../config/env';

export type UserRole = 'ESTIMATOR' | 'SALES_HEAD';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(plainText: string): Promise<boolean>;
}

export interface IUserModel extends Model<IUser> {}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ['ESTIMATOR', 'SALES_HEAD'] as UserRole[],
      required: true,
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Passwords are hashed explicitly via hashPassword() before being assigned to
// passwordHash. There is deliberately no pre-save hook: it would silently
// double-hash values that were already hashed.
export function hashPassword(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, config.bcryptRounds);
}

// Instance method: verify plain-text password against stored hash
UserSchema.methods.comparePassword = function (plainText: string): Promise<boolean> {
  return bcrypt.compare(plainText, this.passwordHash);
};

// Never expose the hash in API responses
UserSchema.set('toJSON', {
  transform(_doc, ret) {
    const out = ret as unknown as Record<string, unknown>;
    delete out.passwordHash;
    return out;
  },
});

export const User = mongoose.model<IUser, IUserModel>('User', UserSchema);

