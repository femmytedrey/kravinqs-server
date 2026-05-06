import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        const message =
          data && typeof data === 'object' && 'message' in data
            ? data.message
            : 'Request successful';

        const { message: _, ...rest } = data ?? {};
        const hasRest = Object.keys(rest).length > 0;

        const response: Record<string, any> = {
          success: true,
          message,
        };

        if (hasRest) {
          response.data = rest;
        }

        return response;
      }),
    );
  }
}
