/**
 * LoopMail - Backend & API config
 */
var LOOPMAIL_API_BASE = 'https://getloopmail.com/api';
// launchWebAuthFlow uses the Chrome Extension client from the manifest (oauth2.client_id).
// Using a Web Application client here causes redirect_uri_mismatch (Error 400) because
// chromiumapp.org URLs are only auto-authorized for Chrome Extension type clients in GCP.
var LOOPMAIL_WEB_OAUTH_CLIENT_ID = '';