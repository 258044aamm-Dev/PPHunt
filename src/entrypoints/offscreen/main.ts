/**
 * SAD-295 (plan 10.2): the offscreen document entrypoint.
 *
 * `runtime` is the only extension API available here, and that is all this file
 * needs: it registers one listener and stays inert otherwise. All parsing and
 * blob bookkeeping lives in `engines/amazon/offscreen/*` so it can be unit
 * tested without a browser.
 */
import { createOffscreenMessageHandler } from '@/engines/amazon/offscreen/handlers';

const listener = createOffscreenMessageHandler();

browser.runtime.onMessage.addListener(listener);
