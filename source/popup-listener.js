import { getRevisions, snoozeRevision } from './phabricator';
import { getBadgeDiagnosticState, updateBadge } from './badge';

//===--------------------------------------------------------------------===//
// Listener interface methods
//===--------------------------------------------------------------------===//

/// Handler object for responding to requests from the popup.
class PopupRequestProxy {
    async getCurrentRevisions() {
        return await getRevisions();
    }
    async snoozeRevision(revisionID) {
        var revisions = await getRevisions();
        await snoozeRevision(revisions, revisionID);
        updateBadge(revisions);
        return true;
    }
}

//===--------------------------------------------------------------------===//
// Listener registration
//===--------------------------------------------------------------------===//

var popupListener = new PopupRequestProxy();

/// Initialize a message listener to convert browser channel messages into
/// method calls on the given object. All methods must return a promise and
/// the result of the promise will be forwarded to the sender.
export function initializePopupListener() {
    var listener = function (request, sender, sendResponse) {
        // Check to see if the badge encountered an error.
        var badgeDiagnosticState = getBadgeDiagnosticState();
        if (badgeDiagnosticState != null) {
            sendResponse({ error: String(badgeDiagnosticState) });
            return false;
        }

        // Otherwise, try to dispatch to the popup listener.
        const methodName = request[0];
        const args = request.slice(1);
        let hasResponded = false;
        (popupListener[methodName]).apply(popupListener, args)
            .then(value => {
                sendResponse({ value: value });
                hasResponded = true;
            }).catch(error => {
                sendResponse({ error: String(error) });
                hasResponded = true;
            });
        return !hasResponded;
    };
    chrome.runtime.onMessage.addListener(listener);
}
