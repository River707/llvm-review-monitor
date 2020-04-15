goog.provide('phabmonitor.popup');

goog.require('goog.dom');

//===--------------------------------------------------------------------===//
// Popup Data
//===--------------------------------------------------------------------===//

/// Dom data for each of the revision section types.
var popupSectionData = {};
popupSectionData['needs_update'] = {
    header: 'Outgoing revisions requiring your attention',
    className: 'outgoingRequiringAttention',
};

popupSectionData['ready_to_submit'] = {
    header: 'Approved, ready to land',
    className: 'approved',
};

popupSectionData['to_review'] = {
    header: 'Incoming revisions requiring your attention',
    className: 'incomingRequiringAttention',
};

/// Data for badge diagnostic states.
var popupErrorText = {
    'invalid-login': 'Please refresh your reviews.llvm.org login',
    'offline': 'Please connect to the internet'
};

//===--------------------------------------------------------------------===//
// Popup Messaging
//===--------------------------------------------------------------------===//

// Send a message to the main module invoking the given function name and
// arguments.
function sendMessage(functionName, ...args) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage([functionName, ...args], (response) => {
            // Check to see if the response returned a value or an error.
            if (response.hasOwnProperty('value'))
                resolve(response.value);
            else
                reject(response.error);
        });
    });
}

// Query the current set of revisions.
function getRevisions() {
    return sendMessage('getCurrentRevisions');
}

// Snooze the revision with the given id.
function snoozeRevision(revisionID) {
    return sendMessage('snoozeRevision', revisionID);
}

//===--------------------------------------------------------------------===//
// Popup Widget
//===--------------------------------------------------------------------===//

/// This class represents the main widget for the popup panel.
class PopupWidget {
    constructor(revisions) {
        this.sections = [];
        for (let [revisionState, revisionList] of Object.entries(revisions))
            if (revisionList.result.data.length != 0)
                this.sections.push(new SectionWidget(revisionState, revisionList.result.data));
    }

    // Return if the widget contains no sections.
    empty() {
        return this.sections.length == 0;
    }

    // Render the widget with the given root element.
    render(parent) {
        this.sections.forEach(function (section) {
            goog.dom.appendChild(parent, section.createDom());
        });
    }
}

//===--------------------------------------------------------------------===//
// Section Widget
//===--------------------------------------------------------------------===//

/// This class represents a specific section of revisions.
class SectionWidget {
    constructor(revisionState, revisions) {
        this.state = revisionState;
        this.revisions = revisions.map(function (revision, index) {
            return new RevisionWidget(revision);
        })
    }

    createDom() {
        var lastIndex = this.revisions.length - 1;
        var data = popupSectionData[this.state];
        return goog.dom.createDom('div', ['section', data.className], [
            goog.dom.createDom('div', ['sectionheader'], [
                goog.dom.createTextNode(data.header)
            ])
        ].concat(this.revisions.map(function (revision, index) {
            var isFirst = (index == 0);
            var isLast = (index == lastIndex);
            return revision.createDom(isFirst, isLast);
        })));
    }
}

//===--------------------------------------------------------------------===//
// Revision Widget
//===--------------------------------------------------------------------===//

/// Register an event on the given node to open a provided url.
function registerURLOnClickEvent(url, node) {
    // Keep default behavior for key combinations and middle button click.
    function keepDefaultBehavior(e) {
        return e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.which == 2;
    }

    function closePopup(e) {
        window.close();
        e.preventDefault();
        e.stopPropagation();
    }

    chrome.tabs.query({ currentWindow: true }, function (tabs) {
        for (let i = 0, tab; tab = tabs[i]; ++i) {
            if (tab.url && tab.url.indexOf(url) == 0) {
                // If we found a tab for the url, add a click event to activate
                // that tab.
                node._tab_id = tab.id;
                node.addEventListener('click', function (e) {
                    if (keepDefaultBehavior(e))
                        return true;
                    chrome.tabs.update(this._tab_id, { active: true });
                    closePopup(e);
                    return false;
                });
                return;
            }
        }

        // If this url isn't an open tab, register an event to open a new tab.
        node.addEventListener('click', function (e) {
            if (keepDefaultBehavior(e))
                return true;
            chrome.tabs.create({ url: url });
            closePopup(e);
            return false;
        });
    });
}

/// This class represents a widget for a specific revision.
class RevisionWidget {
    constructor(revision) {
        this.revision = revision;
        this.detailsExpanded = false;
    }

    /// Event handler for when the top-level header is clicked.
    onHeaderClicked(parent) {
        this.detailsExpanded = !this.detailsExpanded;
        if (this.detailsExpanded)
            parent.parentNode.className += ' expanded';
        else
            parent.parentNode.className = parent.parentNode.className.replace(' expanded', '');
    }

    /// Event handler for when the snooze button is clicked.
    onSnoozeButtonClicked(element) {
        snoozeRevision(this.revision.id);

        // Remove this revision from the parent, or remove the section
        // entirely if this is the only revision.
        var root = goog.dom.getAncestorByClass(element, 'revision', 5);
        if (root.parentNode.childElementCount == 2) {
            root = goog.dom.getAncestorByClass(root, 'section', 5);

            // If this was the last section, display the overlay.
            if (root.parentNode.childElementCount == 1) {
                setOverlayText('No revisions require your attention.');
                setOverlayVisible(true);
            }
        }
        root.parentNode.removeChild(root);
    }

    createDom(isFirst, isLast) {
        var revision = this.revision;
        var reviewers = revision.attachments.reviewers.reviewers;
        var revisionURL = 'https://reviews.llvm.org/D' + revision.id;

        // Map an array interleaved with the given element.
        function mapDomArray(elements, perElementFn, interleaveFn) {
            var result = [];
            for (let i = 0; i < elements.length; ++i) {
                if (i > 0)
                    result.push(interleaveFn());
                result.push(perElementFn(elements[i]));
            }
            return result;
        }

        // Create the snooze button.
        var snoozeButton = goog.dom.createDom('button', {
            class: 'button',
            title: 'Snooze this revision until the next update.'
        }, [
            goog.dom.createTextNode('Snooze')
        ]);
        snoozeButton.addEventListener('click', () => this.onSnoozeButtonClicked(snoozeButton));

        // Create the open button.
        var openButton = goog.dom.createDom('button', {
            class: 'button',
            title: 'Open this revision in Phabricator.'
        }, [
            goog.dom.createTextNode('Open')
        ]);
        registerURLOnClickEvent(revisionURL, openButton);

        // Create the main header for the revision.
        var statusMarker = revision.status == 'accepted' ? 'approved' : 'pending';
        var revisionHeader = goog.dom.createDom('div', [isFirst ? '' : 'notfirst', 'revisionheader'], [
            goog.dom.createDom('table', 'revisiontable', [
                goog.dom.createDom('tr', [], [
                    goog.dom.createDom('td', [], [
                        goog.dom.createDom('div', 'statusmarker', [
                            goog.dom.createDom('div', ['marker', statusMarker + 'marker'])
                        ])
                    ]),
                    goog.dom.createDom('td', [], [
                        goog.dom.createDom('div', 'author', [
                            goog.dom.createTextNode(revision.fields.authorName)
                        ])
                    ]),
                    goog.dom.createDom('td', [], [
                        goog.dom.createDom('div', 'description', [
                            goog.dom.createTextNode(revision.fields.title)
                        ]),
                        snoozeButton,
                        openButton
                    ]),
                    goog.dom.createDom('td', [], [
                        goog.dom.createDom('div', 'action')
                    ]),
                ])
            ])
        ]);
        revisionHeader.addEventListener('click', () => this.onHeaderClicked(revisionHeader));

        // Build the DOM for a specific attribute value.
        function createAttribute(key, valueDom) {
            return goog.dom.createDom('tr', [], [
                goog.dom.createDom('td', 'attribKey', [
                    goog.dom.createTextNode(key)
                ]),
                goog.dom.createDom('td', 'attribValue', valueDom)
            ]);
        }

        // Create the attribute for the revision ID.
        function createIdAttribute() {
            var attr = goog.dom.createDom('a', {
                'href': revisionURL,
                'target': '_blank',
                'title': revisionURL
            }, [
                goog.dom.createTextNode('D' + revision.id)
            ]);
            registerURLOnClickEvent(revisionURL, attr);
            return attr;
        }

        // Create the top-level revision dom.
        return goog.dom.createDom('div', 'revision', [
            revisionHeader,
            goog.dom.createDom('div', ['details', isLast ? '' : 'notlast'], [
                goog.dom.createDom('div', 'message', mapDomArray(
                    revision.fields.summary.split('\n'),
                    line => goog.dom.createTextNode(line),
                    () => goog.dom.createDom('br'))
                ),
                goog.dom.createDom('table', 'attribs', [
                    createAttribute('Id', [createIdAttribute()]),
                    createAttribute('Author', [goog.dom.createTextNode(revision.fields.authorName)]),
                    createAttribute('Reviewers', mapDomArray(reviewers, reviewer => goog.dom.createDom('span',
                        reviewer.status == 'accepted' ? 'approvedreviewer' : 'noapprovedreviewer', [
                        goog.dom.createTextNode(reviewer.reviewerName),
                        goog.dom.createTextNode((reviewer.status != 'accepted' && reviewer.isBlocking == true) ? '*' : '')
                    ]), () => goog.dom.createTextNode(', ')))
                ])
            ])
        ]);
    }
}

//===--------------------------------------------------------------------===//
// Overlay handling
//===--------------------------------------------------------------------===//

/// Display the given error message to the user.
function displayError(error) {
    setOverlayText(popupErrorText[error] || `Unhandled error: ${error}`);
    setOverlayVisible(true);
    setLoginLinkVisible(error.includes('invalid-login'));
}

/// Toggle the visibility of the overlay panel.
function setOverlayVisible(visible) {
    if (visible) {
        document.getElementById('overlay').style.display = 'unset';
        document.getElementById('results').style.display = 'none';
    } else {
        document.getElementById('overlay').style.display = 'none';
        document.getElementById('results').style.display = 'unset';
        setLoginLinkVisible(false);
    }
}

/// Toggle the visibility of the long refresh link.
function setLoginLinkVisible(visible) {
    document.getElementById('refresh-link').style.display =
        visible ? 'unset' : 'none';
}

/// Set the text that is displayed in the overlay panel.
function setOverlayText(value) {
    document.getElementById('overlay-text').innerText = value;
}

//===--------------------------------------------------------------------===//
// Initialization
//===--------------------------------------------------------------------===//

/// Render the main widget for the popup.
function renderMainWidget(widget) {
    if (widget.empty()) {
        setOverlayText('No revisions require your attention.');
        setOverlayVisible(true);
    } else {
        widget.render(document.getElementById('results'));
        setOverlayVisible(false);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    getRevisions()
        .then(revisions => renderMainWidget(new PopupWidget(revisions)))
        .catch(displayError)
});
