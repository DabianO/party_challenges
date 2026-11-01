/** Photos taken on a phone come upright (the browser applies their rotation). */
export async function loadImage(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall back to an <img> below.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function sizeOf(image: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  return 'naturalWidth' in image ? { width: image.naturalWidth, height: image.naturalHeight } : { width: image.width, height: image.height };
}

/** Longest side of photos sent as evidence: sharp on the big screen, quick to upload. */
const PHOTO_MAX_SIDE = 1600;
/** Smaller photos are sent as they are. */
const PHOTO_KEEP_BYTES = 600 * 1024;

/**
 * A phone photo shrunk to at most PHOTO_MAX_SIDE pixels, as a JPEG: a 5 MB camera picture
 * becomes a few hundred kB, so it is uploaded before the phone's connection can drop again.
 * Anything that is not a photo, or is small already, or cannot be read, is returned unchanged.
 */
export async function shrinkPhoto(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size <= PHOTO_KEEP_BYTES) return file;
  try {
    const image = await loadImage(file);
    const { width, height } = sizeOf(image);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]*$/, '') || 'photo'}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
