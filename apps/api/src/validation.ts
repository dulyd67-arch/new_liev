import { Type, ValidationPipe } from '@nestjs/common';

// Explicit expectedType keeps validation identical under tsc and tsx/esbuild,
// which does not emit design:paramtypes metadata.
export function validateDto<T>(type: Type<T>): ValidationPipe {
  return new ValidationPipe({ expectedType: type, whitelist: true, forbidNonWhitelisted: true, transform: true });
}
