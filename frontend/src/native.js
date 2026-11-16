/* ORION native bridge — active only inside the Android app (Capacitor). In a browser this file does nothing.
 *
 *  - Sign-in: the app uses the "mobile" login flow; the refresh token is kept in app-private storage
 *    (Capacitor Preferences → Android SharedPreferences, readable only by this app) and rotated by the server.
 *  - Push: registers with Firebase Cloud Messaging, creates high-importance channels, sends the token to the server.
 *    Phones are a notification channel only — local protection never depends on them.
 *  - Speech: Android's own speech recognition and text-to-speech replace the browser APIs the WebView lacks.
 *  - Network: re-fetches and reconnects when connectivity returns.
 * Plugins are reached through Capacitor.registerPlugin (no bundler needed).
 */
'use strict';
(function () {
  const Cap = window.Capacitor;
  const NATIVE = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const P = (name) => (NATIVE && Cap.registerPlugin ? Cap.registerPlugin(name) : null);
  const Prefs = P('Preferences'), Push = P('PushNotifications'), Net = P('Network'), Speech = P('SpeechRecognition'), TTS = P('TextToSpeech');
  const RT_KEY = 'orion.refresh';

  const native = {
    isNative: NATIVE,
    async loadRefresh() { if (!Prefs) return null; try { const r = await Prefs.get({ key: RT_KEY }); return r && r.value ? r.value : null; } catch (e) { return null; } },
    async saveRefresh(token) { if (!Prefs) return; try { if (token) await Prefs.set({ key: RT_KEY, value: token }); else await Prefs.remove({ key: RT_KEY }); } catch (e) { /* storage unavailable */ } },

    _pushToken: null,
    async registerPush(source) {
      if (!Push) return { ok: false, error: 'not native' };
      try {
        await Push.createChannel({ id: 'orion_emergency', name: 'ORION emergencies', description: 'Smoke, flame and other critical alerts', importance: 5, visibility: 1, vibration: true });
        await Push.createChannel({ id: 'orion_alerts', name: 'ORION alerts', description: 'Warnings and connection problems', importance: 4, visibility: 1, vibration: true });
        let perm = await Push.checkPermissions();
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await Push.requestPermissions();
        if (perm.receive !== 'granted') return { ok: false, error: 'Notifications are turned off for ORION in Android settings.' };
        if (!native._wired) {
          native._wired = true;
          Push.addListener('registration', (t) => {
            native._pushToken = t.value;
            source.api('/push/register', { method: 'POST', body: { token: t.value, platform: 'android' } });
          });
          Push.addListener('registrationError', (e) => console.warn('push registration failed', e));
          Push.addListener('pushNotificationReceived', (n) => {
            if (ORION.app) { ORION.app.toast(n.title || 'ORION alert', 'bad'); if (ORION.app.source.refetch) ORION.app.source.refetch(); }
          });
          Push.addListener('pushNotificationActionPerformed', () => { if (ORION.app) ORION.app.go('alerts'); });
        }
        await Push.register();
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    async unregisterPush(source) {
      if (native._pushToken) await source.api('/push/unregister', { method: 'POST', body: { token: native._pushToken, platform: 'android' } });
    },

    watchNetwork(source) {
      if (!Net) return;
      Net.addListener('networkStatusChange', (s) => {
        if (s.connected && source && source.refetch) { source.refetch(); if (source._openWs) source._openWs(); }
      });
    },

    /* Same interface as the browser dictation adapter in aura-ai.js. */
    dictation() {
      if (!Speech) return null;
      let on = false;
      const L = { partial: [], final: [], state: [] };
      const fire = (k, v) => L[k].forEach((f) => { try { f(v); } catch (e) { console.error(e); } });
      let last = '';
      Speech.addListener('partialResults', (d) => { last = (d.matches && d.matches[0]) || ''; fire('partial', { text: last }); });
      return {
        kind: 'native',
        active: () => on,
        onPartial: (f) => L.partial.push(f), onFinal: (f) => L.final.push(f), onState: (f) => L.state.push(f),
        async start(opts) {
          const perm = await Speech.requestPermissions().catch(() => ({ speechRecognition: 'denied' }));
          if (perm.speechRecognition !== 'granted') throw { code: 'not_granted' };
          const avail = await Speech.available().catch(() => ({ available: false }));
          if (!avail.available) throw { code: 'unavailable' };
          on = true; last = ''; fire('state', { state: 'listening' });
          const BCP = { en: 'en-IN', ml: 'ml-IN', hi: 'hi-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', mr: 'mr-IN', gu: 'gu-IN', pa: 'pa-IN', or: 'or-IN', ur: 'ur-IN', as: 'as-IN' };
          Speech.start({ language: (opts && BCP[opts.language]) || 'en-IN', maxResults: 1, partialResults: true, popup: false })
            .then(() => { if (last) fire('final', { text: last + ' ' }); }, () => {})
            .finally(() => { on = false; fire('partial', { text: '' }); fire('state', { state: 'idle', reason: 'stopped' }); });
        },
        async stop() { try { await Speech.stop(); } catch (e) { /* not listening */ } if (last) fire('final', { text: last + ' ' }); last = ''; },
      };
    },

    /* Android text-to-speech, used by Aura's "device voice" path. */
    speak(text, code, rate) {
      if (!TTS) return Promise.resolve();
      const BCP = { en: 'en-IN', ml: 'ml-IN', hi: 'hi-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', mr: 'mr-IN', gu: 'gu-IN', pa: 'pa-IN', or: 'or-IN', ur: 'ur-IN', as: 'as-IN' };
      return TTS.speak({ text: String(text), lang: BCP[code] || 'en-IN', rate: rate || 1.0, volume: 1.0, category: 'playback' }).catch(() => {});
    },
    stopSpeaking() { if (TTS) TTS.stop().catch(() => {}); },

    /* Called once Aura's capability detection has run. */
    attachAura(AI) {
      if (!NATIVE || !AI) return;
      const d = native.dictation();
      if (d) AI.cap.dict = d;
      if (TTS) {
        AI.cap.browserTts = true;
        AI.speakBrowser = (text, code, onEnd, rate) => { native.speak(text, code, rate).then(() => onEnd && onEnd()); return true; };
        AI.deviceSay = (text, code, rate) => native.speak(text, code, rate);
        AI.stopBrowser = () => native.stopSpeaking();
      }
    },
  };

  ORION.native = native;
})();
