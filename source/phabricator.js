import localStore from './local-store';

//===--------------------------------------------------------------------===//
// Raw Phabricator Conduit API
//===--------------------------------------------------------------------===//

const request = require('request-promise');

/// Invoke the given phabricator API with the given parameters. Returns the
/// result of the API call.
async function callPhabAPI(api, params) {
    // Extract a csrf token from the current users profile.
    var csrf = await fetch('https://reviews.llvm.org/login/refresh/').
        then(r => r.text());
    var tokenMatch = csrf.match(/"token":"([^"]+)/);

    // If we can't extract the token, the user has an invalid login.
    if (!tokenMatch)
        throw 'invalid-login';
    csrf = tokenMatch[1];

    // Query the api method.
    return request.post('https://reviews.llvm.org/api/' + api, {
        form: {
            output: 'json',
            params: JSON.stringify(params)
        },
        headers: {
            'x-phabricator-csrf': csrf
        },
        json: true
    });
}

//===--------------------------------------------------------------------===//
// API for accessing user IDs and names
//===--------------------------------------------------------------------===//

/// Returns the phabricator ID for the current user.
export async function getPhabID() {
    var cachedID = await localStore.get('phabID') || null;
    if (cachedID != undefined)
        return cachedID;

    // Invoke the API for checking the current user.
    var resp = await callPhabAPI('user.whoami');
    await localStore.set('phabID', resp.result.phid);
    return resp.result.phid;
}

/// Returns the username for a given phabricator ID.
var knownPHIDUserNames = {};
async function getNameForPhabID(phabID) {
    var username = knownPHIDUserNames[phabID];
    if (username)
        return username;

    var resp = await callPhabAPI('user.search', {
        'constraints': {
            'phids': [phabID]
        }
    });
    username = resp.result.data[0].fields.username;
    knownPHIDUserNames[phabID] = username;
    return username;
}

//===--------------------------------------------------------------------===//
// API for accessing revision lists
//===--------------------------------------------------------------------===//

/// The various states for revisions that we track.
export const RevisionStates = {
    /// Revisions that the user needs to review.
    ToReview: 'to_review',

    /// Revisions belonging to the user that needs to be updated.
    NeedsUpdate: 'needs_update',

    /// Revisions belonging to the user that are read to submit.
    ReadyToSubmit: 'ready_to_submit',
}

/// A list comprising revisions for each of the different states.
export var revisions = {};

/// Snooze the given revision. This will hide remove it from the display
/// until it has been updated again.
export async function snoozeRevision(revisionID) {
    await localStore.set(`snooze-${revisionID}`, Date.now());

    // Remove this revision from the revision list.
    for (let revisionMap of Object.values(revisions)) {
        var revisionList = revisionMap.result.data;
        for (let i = 0; i < revisionList.length; ++i) {
            if (revisionList[i].id == revisionID) {
                revisionList.splice(i, 1);
                return;
            }
        }
    }
}

/// Compute the usernames for the authors and reviewers of each revision.
async function computeUsernames(revisionMap) {
    var revisionList = revisionMap.result.data;
    for (let i = 0; i < revisionList.length; ++i) {
        var revision = revisionList[i];

        // Check to see if this revision is being snoozed.
        var snoozeDate = await localStore.get(`snooze-${revision.id}`);
        if (snoozeDate) {
            // If the revision hasn't been updated, just splice it out.
            if (snoozeDate > revision.fields.dateModified) {
                revisionList.splice(i--, 1);
                continue;
            }

            // Otherwise, this revision is no longer snoozed.
            await localStore.remove(`snooze-${revision.id}`);
        }

        // Update the author and any reviewers.
        revision.fields.authorName =
            await getNameForPhabID(revision.fields.authorPHID);

        var reviewers = revision.attachments.reviewers.reviewers;
        for (let j = 0; j < reviewers.length; ++j)
            reviewers[j].reviewerName =
                await getNameForPhabID(reviewers[j].reviewerPHID);
    }
    return revisionMap;
}

/// Query the revisions with the provided constraints.
async function queryRevisions(constraints) {
    return callPhabAPI('differential.revision.search', {
        'attachments': {
            'reviewers': true
        },
        'constraints': constraints,
        'order': 'updated'
    }).then(computeUsernames);
}

/// Refresh the current set of revisions.
export async function refreshRevisionList() {
    var userPhabID = await getPhabID();

    // Resolve all of the revision promises.
    let [toReview, needsUpdate, readyToSubmit] = await Promise.all([
        // Compute the revisions that the user needs to review.
        queryRevisions({
            'reviewerPHIDs': [userPhabID],
            'statuses': ['needs-review']
        }),
        // Compute the revisions the user needs to update.
        queryRevisions({
            'authorPHIDs': [userPhabID],
            'statuses': ['needs-revision']
        }),
        // Compute the revisions the user is ready to submit.
        queryRevisions({
            'authorPHIDs': [userPhabID],
            'statuses': ['accepted']
        })
    ]);

    revisions[RevisionStates.ToReview] = toReview;
    revisions[RevisionStates.NeedsUpdate] = needsUpdate;
    revisions[RevisionStates.ReadyToSubmit] = readyToSubmit;
    return revisions;
}