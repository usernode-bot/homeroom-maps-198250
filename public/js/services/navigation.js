// Navigation service — the screen-facing binding of the pure navigation
// session core to the app's real contracts, exactly as the Directions screen
// binds routing-core to /api/directions:
//   fetchRoute  -> services/routing.js (GET /api/directions -> routing/ on
//                  the server -> the configured RoutingProvider adapter)
//   watch       -> services/location.js (the platform permission flow plus
//                  the device's continuous fixes)
//   voice       -> services/navigation/voice.js (NavigationVoiceService)
//
// The session emits semantic voice intents ({ kind, step }); this layer
// resolves them into spoken words through the i18n layer, so spoken copy is
// translated exactly like displayed copy. A maneuver intent carries the
// provider's own step, and its instruction is composed only from the fields
// that step actually carries.
import { createNavigationSession } from './navigation/navigation-core.js';
import { createNavigationVoice } from './navigation/voice.js';
import { maneuverInstruction } from './navigation/maneuvers.js';
import { fetchDirections } from './routing.js';
import { startLocationWatch } from './location.js';
import { t, getLocale } from '../i18n/index.js';

export { NAV_STATE } from './navigation/navigation-core.js';
export { createNavigationVoice, createWebSpeechVoice, createNullVoice } from './navigation/voice.js';

export function createNavigation() {
  const voiceImpl = createNavigationVoice();

  // The session-voice adapter: turns intents into words, honestly silent when
  // the device has no TTS.
  const voice = {
    isAvailable: () => voiceImpl.isAvailable(),
    announce(intent) {
      if (!intent || !voiceImpl.isAvailable()) return;
      let text = null;
      if (intent.kind === 'maneuver') text = maneuverInstruction(intent.step);
      else if (intent.kind === 'rerouting') text = t('navigation.voiceRerouting');
      else if (intent.kind === 'arrived') text = t('navigation.voiceArrived');
      if (!text) return;
      voiceImpl.speak(text, { interrupt: true, lang: getLocale() });
    },
    stop() {
      voiceImpl.stop();
    },
  };

  const session = createNavigationSession({
    fetchRoute: fetchDirections,
    watch: startLocationWatch,
    voice,
  });

  return { session, voice };
}