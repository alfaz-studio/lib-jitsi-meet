/**
 * Browser entry point for lib-jitsi-meet.
 * This file imports JitsiMeetJS and attaches it to the window object,
 * while also merging with any existing window.JitsiMeetJS namespace
 * (matching the behavior of the original index.js).
 */

import JitsiMeetJS from './JitsiMeetJS';

/**
 * Tries to deal with the following problem: {@code JitsiMeetJS} is not only
 * this module, it's also a global (i.e. attached to {@code window}) namespace
 * for all globals of the projects in the Jitsi Meet family. If lib-jitsi-meet
 * is loaded through an HTML {@code script} tag, {@code JitsiMeetJS} will
 * automatically be attached to {@code window}. The solution offered here
 * merges all existing values of the namespace {@code JitsiMeetJS} into the
 * module {@code JitsiMeetJS}.
 *
 * @param {Object} module - The module {@code JitsiMeetJS} (which will be
 * exported and may be attached to {@code window}).
 * @private
 * @returns {Object} - A {@code JitsiMeetJS} module which contains all existing
 * value of the namespace {@code JitsiMeetJS} (if any).
 */
function mergeNamespaceAndModule(module: any) {
    return (
        typeof (window as any).JitsiMeetJS === 'object'
            ? { ...(window as any).JitsiMeetJS,
                ...module }
            : module);
}

// Merge with existing window.JitsiMeetJS if present
const mergedJitsiMeetJS = mergeNamespaceAndModule(JitsiMeetJS);

// Attach to window for global access
(window as any).JitsiMeetJS = mergedJitsiMeetJS;

// Also export as default for module imports
export default mergedJitsiMeetJS;

