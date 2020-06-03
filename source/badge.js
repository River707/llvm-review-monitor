import { RevisionStates } from './phabricator';
import localStore from './local-store';

//===--------------------------------------------------------------------===//
// Badge Data
//===--------------------------------------------------------------------===//

var errorSymbol = 'E';

var colors = {
    'black': '#000000',
    'darkgrey': '#333333',
    'green': '#34a853',
    'red': '#c5221f',
    'yellow': '#f9ab00'
};

/// Data for the various different errors/warnings/etc that may be displayed
/// on the badge.
var badgeData = {};
badgeData['invalid-login'] = {
    title: 'Please refresh your login',
    color: colors.black,
    symbol: errorSymbol
};
badgeData['offline'] = {
    title: 'No Internet Connection',
    color: colors.black,
    symbol: 'X'
};
badgeData[RevisionStates.ToReview] = {
    formatTitle: (prefix, count) => count + ' incoming ' + prefix + ' requiring your attention',
    notification: 'Incoming revision requires your attention',
    color: colors.red,
};
badgeData[RevisionStates.NeedsUpdate] = {
    formatTitle: (prefix, count) => count + ' of your ' + prefix + ' requiring attention',
    notification: 'Your revision requires your attention',
    color: colors.yellow,
};
badgeData[RevisionStates.ReadyToSubmit] = {
    formatTitle: (_, count) => count + ' of your revisions ready to submit',
    notification: 'Your revision is ready to submit',
    color: colors.green,
};

function setBadgeData(text, color, title) {
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setBadgeBackgroundColor({ color });
    browser.browserAction.setTitle({ title });
}

//===--------------------------------------------------------------------===//
// Notication API
//===--------------------------------------------------------------------===//

/// Build a map containing the revision state for each of the given revisions.
function buildRevisionState(revisions) {
    var revisionStatusMap = {};
    for (let [revisionState, revisionList] of Object.entries(revisions))
        for (let i = 0; i < revisionList.length; ++i)
            revisionStatusMap[revisionList[i].id] = {
                state: revisionState,
                revisionTitle: revisionList[i].fields.title
            };
    return revisionStatusMap;
}

/// Send notifications for any new revisions coming in.
export async function sendNotifications(revisions) {
    // Check to see if this is the first update. If it is, then we only need
    // to update the revision state.
    var newRevisionStatusMap = buildRevisionState(revisions);
    var lastRevisionStatusMap = await localStore.get('lastRevisionStatusMap');
    if (!lastRevisionStatusMap) {
        await localStore.set('lastRevisionStatusMap', newRevisionStatusMap);
        return;
    }

    // Walk the new revision state. If any of the revisions have a new state,
    // send a notification to the user.
    for (let [id, revisionStatus] of Object.entries(newRevisionStatusMap)) {
        var lastStatus = lastRevisionStatusMap[id];
        if (lastStatus && lastStatus.state == revisionStatus.state)
            continue;
        // Clear out any previous notifications for this ID.
        chrome.notifications.clear(id.toString());

        var stateBadgeData = badgeData[revisionStatus.state];
        chrome.notifications.create(id.toString(), {
            type: 'basic',
            title: revisionStatus.revisionTitle,
            message: stateBadgeData.notification,
            iconUrl: 'img/icon.png',
            priority: 2,
            requireInteraction: true
        });
    }
    await localStore.set('lastRevisionStatusMap', newRevisionStatusMap);
}

chrome.notifications.onClicked.addListener(revisionID => {
    var revisionURL = 'https://reviews.llvm.org/D' + revisionID;
    chrome.tabs.query({ currentWindow: true }, function (tabs) {
        // Look for an existing tab for the revision and activate it if found.
        for (let i = 0, tab; tab = tabs[i]; ++i) {
            if (tab.url && tab.url.indexOf(revisionURL) == 0) {
                chrome.tabs.update(this._tab_id, { active: true });
                return;
            }
        }
        // Otherwise, open a new tab.
        chrome.tabs.create({ url: revisionURL });
    });
    chrome.notifications.clear(revisionID);
})

//===--------------------------------------------------------------------===//
// Badge Update API
//===--------------------------------------------------------------------===//

/// A variable containing the last diagnostic state of the badge.
var lastDiagnosticState = null;

/// Update the current badge state.
export function updateBadge(revisions) {
    // Reset the diagnostic state.
    lastDiagnosticState = null;

    // Update the badge using the highest priority revision state.
    var revisionStateArray = Object.values(RevisionStates);
    for (let i = 0; i < revisionStateArray.length; ++i) {
        var revisionState = revisionStateArray[i];
        var revisionIt = revisions[revisionState];
        if (revisionIt.length == 0)
            continue;
        var revisionBadgeData = badgeData[revisionState];
        var titlePrefix = (revisionIt.length == 1) ? 'revision' : 'revisions';
        setBadgeData(
            String(revisionIt.length),
            revisionBadgeData.color,
            revisionBadgeData.formatTitle(titlePrefix, revisionIt.length)
        );

        // The first section that has any revisions determines the badge state.
        return;
    }

    // Otherise, reset the badge.
    setBadgeData('', [0, 0, 0, 0], 'No revisions require your attention');
}

/// Render a given diagnostic on the badge.
export function renderBadgeDiagnostic(diag) {
    var diagData = badgeData[diag];
    if (diagData)
        setBadgeData(diagData.symbol, diagData.color, diagData.title);
    else
        setBadgeData(errorSymbol, colors.black, String(diag));
    lastDiagnosticState = diag;
}

/// Get the last diagnostic state of the badge, or null.
export function getBadgeDiagnosticState() {
    return lastDiagnosticState;
}
