export interface PublicProfile {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  locale: string;
  avatarKey: null;
  avatarUrl: string | null;
  followerCount: number;
  followingCount: number;
  broadcastCount: number;
}

export interface ProfileMember {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio?: string | null;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PastStream {
  id: string;
  title: string;
  category: string | null;
  status: 'ENDED';
  startedAt: string;
  endedAt: string | null;
}

const INPUT_BYTES = 2 * 1024 * 1024;
const AVATAR_BYTES = 48 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AVATAR_ROUTE = /^\/api\/v1\/users\/[a-z0-9_][a-z0-9_.-]{1,31}\/avatar(?:\?v=[a-z0-9_-]{1,80})?$/i;

export function firstInitial(name: string): string {
  return Array.from(name.trim())[0] || 'L';
}

function matchesImageType(type: string, bytes: ArrayLike<number>): boolean {
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') {
    return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  }
  return type === 'image/webp' && bytes.length >= 12
    && [0x52, 0x49, 0x46, 0x46].every((value, index) => bytes[index] === value)
    && [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value);
}

function dataImage(source: string): { type: string; bytes: number } | null {
  // Bound the input before applying a pattern or decoding it. An SVG, remote
  // URL or arbitrary data document never becomes an image source here.
  if (source.length > Math.ceil(AVATAR_BYTES / 3) * 4 + 32) return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
  if (!match || match[2].length % 4 !== 0) return null;
  try {
    const decoded = atob(match[2]);
    if (!decoded.length || decoded.length > AVATAR_BYTES || btoa(decoded) !== match[2]) return null;
    const prefix = Array.from(decoded.slice(0, 12), character => character.charCodeAt(0));
    if (!matchesImageType(match[1], prefix)) return null;
    return { type: match[1], bytes: decoded.length };
  } catch { return null; }
}

export function safeAvatarSource(source: string | null | undefined): string | undefined {
  if (!source || typeof source !== 'string') return undefined;
  if (source.length <= 180 && AVATAR_ROUTE.test(source)) return source;
  return dataImage(source) ? source : undefined;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    let expired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const pending = createImageBitmap(file);
    // ImageBitmap decoding cannot be canceled. Dispose a late result after a
    // timeout instead of leaving its image memory alive.
    void pending.then(bitmap => { if (expired) bitmap.close(); }, () => undefined);
    try {
      const bitmap = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { expired = true; reject(new Error('AVATAR_DECODE')); }, 10_000);
        }),
      ]);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
    } finally { if (timeout) clearTimeout(timeout); }
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { image.src = ''; reject(new Error('AVATAR_DECODE')); }, 10_000);
      image.onload = () => { clearTimeout(timeout); resolve(); };
      image.onerror = () => { clearTimeout(timeout); reject(new Error('AVATAR_DECODE')); };
      image.src = objectUrl;
    });
    return {
      source: image, width: image.naturalWidth, height: image.naturalHeight,
      dispose: () => { image.src = ''; },
    };
  } finally {
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(objectUrl);
  }
}

export async function prepareAvatar(file: File): Promise<string> {
  if (!IMAGE_TYPES.has(file.type)) throw new Error('AVATAR_TYPE');
  if (!file.size || file.size > INPUT_BYTES) throw new Error('AVATAR_SIZE');
  let prefix: Uint8Array;
  try { prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer()); }
  catch { throw new Error('AVATAR_DECODE'); }
  if (!matchesImageType(file.type, prefix)) throw new Error('AVATAR_TYPE');
  if (typeof document === 'undefined') throw new Error('AVATAR_DECODE');

  let decoded: DecodedImage | undefined;
  try {
    decoded = await decodeImage(file);
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_SOURCE_PIXELS) throw new Error('AVATAR_SIZE');
    const scale = Math.min(1, 256 / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('AVATAR_DECODE');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

    for (const type of ['image/webp', 'image/jpeg']) {
      if (type === 'image/jpeg') {
        // JPEG has no alpha channel. Supply a neutral background if a
        // transparent source must use this encoder as a browser fallback.
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#21172b';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.globalCompositeOperation = 'source-over';
      }
      for (const quality of [.86, .74, .6, .46, .32]) {
        const result = canvas.toDataURL(type, quality);
        const encoded = dataImage(result);
        if (encoded?.type === type) return result;
      }
    }
    throw new Error('AVATAR_SIZE');
  } catch (error) {
    if (error instanceof Error && /^AVATAR_(?:TYPE|SIZE|DECODE)$/.test(error.message)) throw error;
    throw new Error('AVATAR_DECODE');
  } finally { decoded?.dispose(); }
}
