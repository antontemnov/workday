import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { WorkdayApiService } from '../services/workday-api.service';
import { HttpWorkdayApiService } from '../services/http-workday-api.service';

// Minimal bootstrap config for the toast window: acks go straight to the
// daemon over HTTP, no mock branch — the toast never runs in browser dev.
export const toastConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    { provide: WorkdayApiService, useClass: HttpWorkdayApiService },
  ],
};
