import localStore from './local-store';
import { Mutex } from 'async-mutex'

//===--------------------------------------------------------------------===//
// Raw Phabricator Conduit API
//===--------------------------------------------------------------------===//

const request = require('request-promise');

/// Query a csrf login token for phabricator.
async function getCSRFToken() {
    // Extract a csrf token from the current users profile.
    var csrf = await fetch('https://reviews.llvm.org/login/refresh/').
        then(r => r.text());
    var tokenMatch = csrf.match(/"token":"([^"]+)/);

    // If we can't extract the token, the user has an invalid login.
    if (!tokenMatch)
        throw 'invalid-login';
    return tokenMatch[1];
}

/// Invoke the given phabricator API with the given parameters. Returns the
/// result of the API call.
async function callPhabAPI(api, token, params) {
    // Query the api method.
    return request.post('https://reviews.llvm.org/api/' + api, {
        form: {
            output: 'json',
            params: JSON.stringify(params)
        },
        headers: {
            'x-phabricator-csrf': token
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
    var token = await getCSRFToken();

    // Invoke the API for checking the current user.
    var resp = await callPhabAPI('user.whoami', token);
    await localStore.set('phabID', resp.result.phid);
    return resp.result.phid;
}

/// Returns the username for a given phabricator ID.
var knownPHIDUserNames = {};
async function getNameForPhabID(phabID, token) {
    var username = knownPHIDUserNames[phabID];
    if (username)
        return username;

    var resp = await callPhabAPI('user.search', token, {
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
var revisions = {};
var revisionMutex = new Mutex();

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
async function computeUsernames(revisionMap, token) {
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
            await getNameForPhabID(revision.fields.authorPHID, token);

        var reviewers = revision.attachments.reviewers.reviewers;
        for (let j = 0; j < reviewers.length; ++j)
            reviewers[j].reviewerName =
                await getNameForPhabID(reviewers[j].reviewerPHID, token);
    }
    return revisionMap;
}

/// Query the revisions with the provided constraints.
async function queryRevisions(token, constraints) {
    return callPhabAPI('differential.revision.search', token, {
        'attachments': {
            'reviewers': true
        },
        'constraints': constraints,
        'order': 'updated'
    }).then(revisionMap => computeUsernames(revisionMap, token));
}

/// Refresh the current set of revisions.
export async function refreshRevisionList() {
    var userPhabID = await getPhabID();
    var token = await getCSRFToken();

    // Resolve all of the revision promises.
    let [toReview, needsUpdate, readyToSubmit] = await Promise.all([
        // Compute the revisions that the user needs to review.
        queryRevisions(token, {
            'reviewerPHIDs': [userPhabID],
            'statuses': ['needs-review']
        }),
        // Compute the revisions the user needs to update.
        queryRevisions(token, {
            'authorPHIDs': [userPhabID],
            'statuses': ['needs-revision']
        }),
        // Compute the revisions the user is ready to submit.
        queryRevisions(token, {
            'authorPHIDs': [userPhabID],
            'statuses': ['accepted']
        })
    ]);

    return revisionMutex.runExclusive(async () => {
        // Only update the revision state if we got a valid response.
        if (toReview)
            revisions[RevisionStates.ToReview] = toReview;
        if (needsUpdate)
            revisions[RevisionStates.NeedsUpdate] = needsUpdate;
        if (readyToSubmit)
            revisions[RevisionStates.ReadyToSubmit] = readyToSubmit;
        return revisions;
    });
}

/// Query the current set of revisions.
export async function getRevisions() {
    return revisionMutex.runExclusive(async () => {
        // Return a copy of the revisions to avoid being
        // overwritten by an asynchronous update.
        return JSON.parse(JSON.stringify(revisions));
    });
}
