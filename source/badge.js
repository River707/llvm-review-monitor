import { RevisionStates } from './phabricator';

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
    color: colors.red,
};
badgeData[RevisionStates.NeedsUpdate] = {
    formatTitle: (_, count) => count + ' of your revisions ready to submit',
    color: colors.yellow,
};
badgeData[RevisionStates.ReadyToSubmit] = {
    formatTitle: (prefix, count) => count + ' of your ' + prefix + ' requiring attention',
    color: colors.green,
};

function setBadgeData(text, color, title) {
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setBadgeBackgroundColor({ color });
    browser.browserAction.setTitle({ title });
}

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
