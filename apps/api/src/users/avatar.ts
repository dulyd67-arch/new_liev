import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';

export const MAX_AVATAR_BYTES = 48 * 1024;
export const MAX_AVATAR_DATA_URL_LENGTH = 65559;
export const MAX_AVATAR_DIMENSION = 512;

export interface ProfileAvatar {
  dataUrl: string;
  bytes: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  version: string;
}

const errorMessage = 'Choose a JPEG, PNG or WebP image up to 48 KiB and 512 × 512 pixels.';

export function parseProfileAvatar(value: string): ProfileAvatar {
  const invalid = (): never => { throw new BadRequestException(errorMessage); };
  if (typeof value !== 'string' || value.length > MAX_AVATAR_DATA_URL_LENGTH) return invalid();
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return invalid();
  const encoded = match[2]!;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES || bytes.toString('base64') !== encoded) return invalid();
  const contentType = match[1] as ProfileAvatar['contentType'];
  if (contentType === 'image/png' && (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex')))) return invalid();
  if (contentType === 'image/jpeg' && (bytes.length < 4 || !bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) || !bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex')))) return invalid();
  if (contentType === 'image/webp' && (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8)) return invalid();
  try {
    const dimensions = imageSize(bytes);
    const expectedType = contentType === 'image/jpeg' ? 'jpg' : contentType.slice(6);
    if (dimensions.type !== expectedType || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)
      || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_AVATAR_DIMENSION || dimensions.height > MAX_AVATAR_DIMENSION) return invalid();
  } catch { return invalid(); }
  return { dataUrl: value, bytes, contentType, version: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
}

export function storedProfileAvatar(value: string | null): ProfileAvatar | null {
  if (!value) return null;
  try { return parseProfileAvatar(value); } catch { return null; }
}

export function publicAvatarUrl(username: string, value: string | null): string | null {
  const avatar = storedProfileAvatar(value);
  return avatar ? `/api/v1/users/${encodeURIComponent(username)}/avatar?v=${avatar.version}` : null;
}
