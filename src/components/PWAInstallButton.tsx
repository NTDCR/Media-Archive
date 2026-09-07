import React, { useState } from 'react';
import { Download, Smartphone, Share, PlusSquare, CheckCircle, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);

  // If already running as an installed standalone PWA, hide or show minimal indicator
  if (isInstalled) {
    return (
      <div className="hidden sm:flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-emerald-950/40 border border-emerald-700/50 text-[11px] font-medium text-emerald-300">
        <CheckCircle className="w-3 h-3 text-emerald-400" />
        <span>Installed PWA</span>
      </div>
    );
  }

  // Chromium / Android / Desktop flow
  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/20 transition-all duration-200 cursor-pointer"
        title="Install Notes on your phone or computer"
      >
        <Download className="w-3.5 h-3.5 text-slate-950 stroke-[2.5]" />
        <span>Install App</span>
      </button>
    );
  }

  // iOS Safari flow
  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/20 transition-all duration-200 cursor-pointer"
          title="Install Notes on iPhone / iPad"
        >
          <Smartphone className="w-3.5 h-3.5 text-slate-950 stroke-[2.5]" />
          <span>Install on iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center space-x-2.5">
                  <img src="/icon.svg" alt="Notes" className="w-8 h-8 rounded-lg shadow" />
                  <div>
                    <h3 className="text-sm font-bold text-white">Install "Notes" PWA</h3>
                    <p className="text-[11px] text-slate-400">iOS Safari Home Screen</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3 text-xs text-slate-300">
                <div className="flex items-start space-x-3 p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 shrink-0">
                    <Share className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="font-semibold text-white">1. Tap the Share button</p>
                    <p className="text-slate-400 text-[11px]">Located in the bottom Safari toolbar on your iPhone or top-right on iPad.</p>
                  </div>
                </div>

                <div className="flex items-start space-x-3 p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400 shrink-0">
                    <PlusSquare className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="font-semibold text-white">2. Select "Add to Home Screen"</p>
                    <p className="text-slate-400 text-[11px]">Scroll down the share sheet and tap "Add to Home Screen".</p>
                  </div>
                </div>

                <div className="flex items-start space-x-3 p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 shrink-0">
                    <CheckCircle className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="font-semibold text-white">3. Tap "Add"</p>
                    <p className="text-slate-400 text-[11px]">The "Notes" app icon will be installed directly on your home screen!</p>
                  </div>
                </div>
              </div>

              <button
                onClick={() => setShowIOSGuide(false)}
                className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  // Fallback for browsers before prompt fires or desktop Chrome menu
  return (
    <>
      <button
        onClick={() => setShowHelpModal(true)}
        className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/20 transition-all duration-200 cursor-pointer"
        title="Install as Progressive Web App"
      >
        <Download className="w-3.5 h-3.5 text-slate-950 stroke-[2.5]" />
        <span>Install App</span>
      </button>

      {showHelpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2.5">
                <img src="/icon.svg" alt="Notes" className="w-8 h-8 rounded-lg shadow" />
                <div>
                  <h3 className="text-sm font-bold text-white">Install "Notes" App</h3>
                  <p className="text-[11px] text-slate-400">Progressive Web App</p>
                </div>
              </div>
              <button
                onClick={() => setShowHelpModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-300">
              <p className="text-slate-300 leading-relaxed">
                You can install <strong>Notes</strong> on your home screen or desktop for fast, standalone access:
              </p>
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <p className="font-semibold text-amber-400">On Chrome / Edge / Brave:</p>
                <p className="text-slate-400 text-[11px]">
                  Click the install icon in your browser address bar (top-right) or open menu (⋮) → "Install Notes" or "Save and share" → "Install page as app".
                </p>
              </div>
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <p className="font-semibold text-indigo-400">On Mobile (Android / iOS):</p>
                <p className="text-slate-400 text-[11px]">
                  Open browser menu (⋮ or Share icon) and tap <strong>"Add to Home Screen"</strong> or <strong>"Install app"</strong>.
                </p>
              </div>
            </div>

            <button
              onClick={() => setShowHelpModal(false)}
              className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs transition"
            >
              Understood
            </button>
          </div>
        </div>
      )}
    </>
  );
};
