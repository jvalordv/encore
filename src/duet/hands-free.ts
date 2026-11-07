/**
 * The Bluetooth "Hands-Free" warning. A Bluetooth headset that offers its
 * microphone drops to call quality (narrow band, heavy processing) while the
 * mic is in use, and Windows lists that mic as "Headset (... Hands-Free AG
 * Audio)". The label is the only thing a browser tells us, so the check reads
 * it; the device pickers show the warning beside such a mic.
 */

/** What the pickers say beside a Hands-Free mic. */
export const HANDS_FREE_WARNING =
  'A Bluetooth headset mic drops the headset to call quality while it is in use: the song will sound thin and your pitch is less accurate. Use the headset for listening and another mic for singing.';

/**
 * True when a device label names a Bluetooth Hands-Free (call profile) mic.
 * Windows labels such as "Headset (Foo Hands-Free AG Audio)" match. A generic
 * speakerphone that calls itself "Hands-free" matches too: the warning is
 * harmless there, and a label is all a browser gives us.
 */
export function isHandsFreeLabel(label: string): boolean {
  return /hands[\s-]?free|\bhfp\b/i.test(label);
}
