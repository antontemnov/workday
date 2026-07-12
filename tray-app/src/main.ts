import { bootstrapApplication } from '@angular/platform-browser';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { toastConfig } from './app/toast/toast.config';
import { ToastHostComponent } from './app/toast/toast-host.component';

// One bundle, two windows: the Tauri window label picks the root component.
// "toast" renders the notification card; anything else (including browser
// dev, where the Tauri API throws) boots the main shell.
function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return 'main';
  }
}

if (windowLabel() === 'toast') {
  document.body.classList.add('toast-window');
  bootstrapApplication(ToastHostComponent, toastConfig)
    .catch((err) => console.error(err));
} else {
  bootstrapApplication(AppComponent, appConfig)
    .catch((err) => console.error(err));
}
