import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type UserContent = SDKUserMessage['message']['content'];
type ContentBlocks = Exclude<UserContent, string>;

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type TurnImage = { mediaType: ImageMediaType; data: Uint8Array };

export const TURN_CONTENT_LIMITS = Object.freeze({
  imageMediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const),
  maxImagesPerTurn: 8,
  maxImageBytes: 3_670_016,
  maxContentBytes: 3_670_016,
});

function startsWith(data: Uint8Array, magic: readonly number[], offset = 0): boolean {
  return data.length >= offset + magic.length && magic.every((byte, index) => data[offset + index] === byte);
}

export function sniffImage(data: Uint8Array): ImageMediaType | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export function checkTurnContent(images: TurnImage[]): string | null {
  if (images.length > TURN_CONTENT_LIMITS.maxImagesPerTurn) return 'turn_content_too_many';
  let total = 0;
  for (const image of images) {
    if (!(TURN_CONTENT_LIMITS.imageMediaTypes as readonly string[]).includes(image.mediaType)) return 'turn_content_media_type';
    if (image.data.byteLength === 0) return 'turn_content_empty_image';
    if (image.data.byteLength > TURN_CONTENT_LIMITS.maxImageBytes) return 'turn_content_image_too_large';
    if (sniffImage(image.data) !== image.mediaType) return 'turn_content_magic_mismatch';
    total += image.data.byteLength;
    if (total > TURN_CONTENT_LIMITS.maxContentBytes) return 'turn_content_too_large';
  }
  return null;
}

export function userContent(text: string, images: TurnImage[]): UserContent {
  if (images.length === 0) return text;
  // The Messages API refuses a text block that is only whitespace, so an image turn drops it.
  const blocks: ContentBlocks = text.trim() === '' ? [] : [{ type: 'text', text }];
  for (const image of images) {
    blocks.push({ type: 'image', source: {
      type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64'),
    } });
  }
  return blocks;
}
