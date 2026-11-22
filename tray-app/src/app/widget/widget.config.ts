import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { WorkdayApiService } from '../services/workday-api.service';
import { HttpWorkdayApiService } from '../services/http-workday-api.service';
import { MockWorkdayApiService } from '../services/mock-workday-api.service';

// Bootstrap config for the desktop widget's window. In Tauri the widget never
// calls the daemon — the main window does; the API service is there for the
// browser preview (?widget=1&mock=1&timers=1).
const useMock = typeof location !== 'undefined' && /[?&]mock=1\b/.test(location.search);

export const widgetConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    { provide: WorkdayApiService, useClass: useMock ? MockWorkdayApiService : HttpWorkdayApiService },
  ],
};
