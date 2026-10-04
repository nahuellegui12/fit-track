export function initializeWebPwa(): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.lang = 'es';

  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport && !viewport.content.includes('viewport-fit=cover')) {
    viewport.content = `${viewport.content}, viewport-fit=cover`;
  }

  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = '/manifest.webmanifest';
  document.head.appendChild(manifest);

  const themeColor = document.createElement('meta');
  themeColor.name = 'theme-color';
  themeColor.content = '#f3f5fb';
  document.head.appendChild(themeColor);

  const appleCapable = document.createElement('meta');
  appleCapable.name = 'apple-mobile-web-app-capable';
  appleCapable.content = 'yes';
  document.head.appendChild(appleCapable);

  const appleStatusBar = document.createElement('meta');
  appleStatusBar.name = 'apple-mobile-web-app-status-bar-style';
  appleStatusBar.content = 'default';
  document.head.appendChild(appleStatusBar);

  const appleTouchIcon = document.createElement('link');
  appleTouchIcon.rel = 'apple-touch-icon';
  appleTouchIcon.href = '/fittrack-icon.png';
  document.head.appendChild(appleTouchIcon);

  const safeAreaStyle = document.createElement('style');
  safeAreaStyle.textContent = `
    body {
      box-sizing: border-box;
      padding-top: env(safe-area-inset-top);
      padding-right: env(safe-area-inset-right);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      background: #f3f5fb;
    }
  `;
  document.head.appendChild(safeAreaStyle);

  document.title = 'FitTrack';

  if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => undefined);
    });
  }
}
