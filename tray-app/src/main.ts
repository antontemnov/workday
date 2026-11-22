import { bootstrapApplication } from '@angular/platform-browser';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { toastConfig } from './app/toast/toast.config';
import { ToastHostComponent } from './app/toast/toast-host.component';
import { widgetConfig } from './app/widget/widget.config';
import { WidgetHostComponent } from './app/widget/widget-host.component';

// One bundle, three windows: the Tauri window label picks the root component.
// "toast" renders the notification card, "widget" the desktop timers;
// anything else (including browser dev, where the Tauri API throws) boots the
// main shell. In a browser ?widget=1 previews the widget's plate.
function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return /[?&]widget=1\b/.test(location.search) ? 'widget' : 'main';
  }
}

const label = windowLabel();

if (label === 'toast') {
  document.body.classList.add('toast-window');
  bootstrapApplication(ToastHostComponent, toastConfig)
    .catch((err) => console.error(err));
} else if (label === 'widget') {
  document.body.classList.add('widget-window');
  bootstrapApplication(WidgetHostComponent, widgetConfig)
    .catch((err) => console.error(err));
} else {
  bootstrapApplication(AppComponent, appConfig)
    .catch((err) => console.error(err));
}
