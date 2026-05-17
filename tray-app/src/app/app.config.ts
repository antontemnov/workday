import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { WorkdayApiService } from './services/workday-api.service';
import { HttpWorkdayApiService } from './services/http-workday-api.service';
import { MockWorkdayApiService } from './services/mock-workday-api.service';

// Browser preview override: append ?mock=1 to the URL to drive the UI from
// MockWorkdayApiService instead of hitting the local daemon. No effect in
// the Tauri runtime (no query string there).
const useMock = typeof location !== 'undefined' && /[?&]mock=1\b/.test(location.search);

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    { provide: WorkdayApiService, useClass: useMock ? MockWorkdayApiService : HttpWorkdayApiService },
  ],
};
