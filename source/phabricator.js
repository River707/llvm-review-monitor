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
export async function getPhabID(token) {
    var cachedID = await localStore.get('phabID') || null;
    if (cachedID != undefined)
        return cachedID;

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
var revisions = {
    [RevisionStates.ToReview]: [],
    [RevisionStates.NeedsUpdate]: [],
    [RevisionStates.ReadyToSubmit]: []
};
var revisionMutex = new Mutex();
var updateMutex = new Mutex();
var lastRevisionUpdate = 0;

/// Snooze the given revision. This will hide remove it from the display
/// until it has been updated again.
export async function snoozeRevision(revisionID) {
    // Remove this revision from the revision list.
    for (let revisionList of Object.values(revisions)) {
        for (let i = 0; i < revisionList.length; ++i) {
            var revision = revisionList[i];
            if (revision.id == revisionID) {
                await localStore.set(`snooze-${revisionID}`, revision.fields.dateModified);
                revisionList.splice(i, 1);
                return;
            }
        }
    }
}

/// Given a revision, get the author PHID of the last modified transaction on
/// that revision.
async function getLastTransactionAuthor(revision, token) {
    return await callPhabAPI('transaction.search', token, {
        'objectIdentifier': revision.phid,
        'limit': 10,
    }).then(transactionResult => {
        var transactionList = transactionResult.result.data;
        for (let i = 0; i < transactionList.length; ++i) {
            var transaction = transactionList[i];
            if (transaction.type) {
                revision.fields.lastModifiedAuthor = transaction.authorPHID;
                break;
            }
        }
    });
}

/// Compute the usernames for the authors and reviewers of each revision.
async function computeUsernames(revisionList, token) {
    for (let i = 0; i < revisionList.length; ++i) {
        var revision = revisionList[i];

        // Check to see if this revision is being snoozed.
        var snoozeDate = await localStore.get(`snooze-${revision.id}`);
        if (snoozeDate) {
            // If the revision hasn't been updated, just splice it out.
            if (snoozeDate >= revision.fields.dateModified) {
                revisionList.splice(i--, 1);
                continue;
            }

            // Otherwise, this revision is no longer snoozed.
            await localStore.remove(`snooze-${revision.id}`);
        }

        // Get the updated modified date using the transaction data.
        await getLastTransactionAuthor(revision, token);

        // Update the author and any reviewers.
        revision.fields.authorName =
            await getNameForPhabID(revision.fields.authorPHID, token);

        var reviewers = revision.attachments.reviewers.reviewers;
        for (let j = 0; j < reviewers.length; ++j)
            reviewers[j].reviewerName =
                await getNameForPhabID(reviewers[j].reviewerPHID, token);
    }
    return revisionList;
}

/// Given a set of revions, filter out the ones that were last updated by the
/// user.
async function filterRevisionsLastUpdateByUser(revisionList, userPHID) {
    for (let i = 0; i < revisionList.length;) {
        var revision = revisionList[i];

        // If the last comment is from the user, filter this revision out.
        if (revision.fields.lastModifiedAuthor == userPHID)
            revisionList.splice(i, 1);
        else
            ++i;
    }
    return revisionList;
}

/// Query the revisions with the provided constraints.
async function queryRevisions(token, constraints) {
    return callPhabAPI('differential.revision.search', token, {
        'attachments': {
            'reviewers': true
        },
        'constraints': constraints,
        'order': 'updated'
    }).then(revisionMap => computeUsernames(revisionMap.result.data, token));
}

/// Returns true if the revision list needs to be refreshed, false
/// otherwise.
async function shouldRefreshRevisionList(userPhabID, token) {
    // Get the lastest update for the given revisions.
    var getLastUpdate = async constraintTag => {
        return callPhabAPI('differential.revision.search', token, {
            'constraints': {
                [constraintTag]: [userPhabID],
            },
            'limit': 1,
            'order': 'updated'
        }).then(revisionPing => {
            // Check if the modification date is after the last revision list
            // update.
            var revisionList = revisionPing.result.data;
            if (revisionList.length == 0)
                return 0;
            return revisionList[0].fields.dateModified;
        });
    };

    // Check to see if any of the reviewed revisions have been updated.
    var latestUpdate = Math.max(
        await getLastUpdate('authorPHIDs'),
        await getLastUpdate('reviewerPHIDs')
    );
    if (latestUpdate <= lastRevisionUpdate)
        return false;
    lastRevisionUpdate = latestUpdate;
    return true;
}

/// Refresh the current set of revisions.
export async function refreshRevisionList() {
    var token = await getCSRFToken();
    var userPhabID = await getPhabID(token);

    return await updateMutex.runExclusive(async () => {
        // Check to see if we need to update the revision list.
        var shouldRefresh = await shouldRefreshRevisionList(userPhabID, token);
        if (!shouldRefresh)
            return revisions;

        let [toReview, needsUpdate, readyToSubmit] = await Promise.all([
            // Compute the revisions that the user needs to review.
            queryRevisions(token, {
                'reviewerPHIDs': [userPhabID],
                'statuses': ['needs-review']
            }).then(result => filterRevisionsLastUpdateByUser(result, userPhabID)),
            // Compute the revisions the user needs to update.
            queryRevisions(token, {
                'authorPHIDs': [userPhabID],
                'statuses': ['needs-review', 'needs-revision']
            }).then(result => filterRevisionsLastUpdateByUser(result, userPhabID)),
            // Compute the revisions the user is ready to submit.
            queryRevisions(token, {
                'authorPHIDs': [userPhabID],
                'statuses': ['accepted']
            })
        ]);

        return await revisionMutex.runExclusive(async () => {
            revisions = {
                [RevisionStates.ToReview]: toReview,
                [RevisionStates.NeedsUpdate]: needsUpdate,
                [RevisionStates.ReadyToSubmit]: readyToSubmit
            };
            return revisions;
        });
    });
}

/// Query the current set of revisions.
export async function getRevisions() {
    return await revisionMutex.runExclusive(async () => {
        return JSON.parse(JSON.stringify(revisions));
    });
}
