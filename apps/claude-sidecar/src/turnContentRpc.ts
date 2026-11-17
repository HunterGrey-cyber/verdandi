import { createHash } from 'node:crypto';
import { checkTurnContent, type ImageMediaType, type TurnImage } from '@verdandi/claude-runtime';
import { ErrorCode, type SendTurnRequest } from './generated/verdandi/claude/runtime/v1/runtime.js';
import { SidecarError } from './errorMapping.js';

function refuse(reason: string): never {
  throw new SidecarError(ErrorCode.ERROR_CODE_INVALID_CONFIGURATION, `invalid turn content: ${reason}`, reason);
}

export function turnContentFromRpc(content: SendTurnRequest['content'] | undefined): {
  images: TurnImage[];
  payload: { content?: Array<{ mediaType: ImageMediaType; sha256: string }> };
} {
  const images = (content ?? []).map((block): TurnImage => {
    if (block.image === undefined) refuse('turn_content_media_type');
    return { mediaType: block.image.mediaType as ImageMediaType, data: block.image.data };
  });
  const problem = checkTurnContent(images);
  if (problem !== null) refuse(problem);
  // Older clients omit content; an empty list must keep their payload hash byte-for-byte.
  const payload = images.length === 0 ? {} : { content: images.map(image => ({
    mediaType: image.mediaType,
    sha256: createHash('sha256').update(image.data).digest('hex'),
  })) };
  return { images, payload };
}
