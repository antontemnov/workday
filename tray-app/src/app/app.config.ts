import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { WorkdayApiService } from './services/workday-api.service';
import { HttpWorkdayApiService } from './services/http-workday-api.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    { provide: WorkdayApiService, useClass: HttpWorkdayApiService },
  ],
};
