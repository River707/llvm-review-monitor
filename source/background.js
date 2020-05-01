import { initializePopupListener } from './popup-listener';
import { renderBadgeDiagnostic, updateBadge, sendNotifications } from './badge';
import { refreshRevisionList } from './phabricator'

/// Reset the alarm used for updating the badge.
async function resetAlarm() {
	const delayInSeconds = 60;
	var delayInMinutes = Math.max(Math.ceil(delayInSeconds / 60), 1);
	chrome.alarms.create({ delayInMinutes });
}

/// Handle any errors that pop up during updates.
function handleError(error) {
	if (!navigator.onLine)
		error = 'offline';
	renderBadgeDiagnostic(error);
}

/// Handle the state when there is no internet connection.
function onOffline() {
	renderBadgeDiagnostic('offline');
	resetAlarm();
}

async function update() {
	if (!navigator.onLine) {
		onOffline();
		return;
	}

	// Make sure the revision list is up-to-date, then
	// update the badge.
	await refreshRevisionList()
		.then(revisions => {
			updateBadge(revisions);
			sendNotifications(revisions);
		})
		.catch(error => handleError(error))
		.finally(() => resetAlarm());
}

function onConnectionUpdate() {
	// If we are online, update as normal.
	if (navigator.onLine)
		update();
	else
		onOffline();
}

function init() {
	// Add handlers for when the browser is online and offline.
	window.addEventListener('online', onConnectionUpdate);
	window.addEventListener('offline', onConnectionUpdate);

	chrome.alarms.onAlarm.addListener(update);
	initializePopupListener();
	update();
}

init();
