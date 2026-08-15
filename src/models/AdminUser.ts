import { Schema, model, InferSchemaType } from 'mongoose';

export const adminUserSchema = new Schema({
  username: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

export type AdminUser = InferSchemaType<typeof adminUserSchema>;

export const AdminUserModel = model('AdminUser', adminUserSchema);