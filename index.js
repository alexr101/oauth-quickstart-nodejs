require('dotenv').config();
const express = require('express');
const request = require('request-promise-native');
const NodeCache = require('node-cache');
const session = require('express-session');
const opn = require('open');
const app = express();

const PORT = process.env.PORT || 80

const refreshTokenStore = {};
const accessTokenCache = new NodeCache({ deleteOnExpire: true });
const ENV = {
  LOCALHOST: 'LOCALHOST',
  QA: 'QA',
  PROD: 'PROD'
}
let hubspotEnv = process.env.HUBSPOT_ENV.toUpperCase() === ENV.QA ? ENV.QA : ENV.PROD;
console.log({hubspotEnv})

if (!process.env.CLIENT_ID_PROD || !process.env.CLIENT_SECRET_PROD) {
    throw new Error('Missing CLIENT_ID or CLIENT_SECRET environment variable.')
}

//===========================================================================//
//  HUBSPOT APP CONFIGURATION
//
//  All the following values must match configuration settings in your app.
//  They will be used to build the OAuth URL, which users visit to begin
//  installing. If they don't match your app's configuration, users will
//  see an error page.

// Replace the following with the values from your app auth config, 
// or set them as environment variables before running.
let CLIENT_ID;
let CLIENT_SECRET;

const generateClientCredentials = () => {
  console.log({hubspotEnv})
  CLIENT_ID = hubspotEnv.toUpperCase()===ENV.QA ? process.env.CLIENT_ID_QA : process.env.CLIENT_ID_PROD;
  CLIENT_SECRET = hubspotEnv.toUpperCase()===ENV.QA ? process.env.CLIENT_SECRET_QA : process.env.CLIENT_SECRET_PROD;
}
generateClientCredentials();

// Scopes for this app will default to `contacts`
// To request others, set the SCOPE environment variable instead
let SCOPES = ['contacts'];
if (process.env.SCOPE) {
    SCOPES = (process.env.SCOPE.split(/ |, ?|%20/)).join(' ');
}

let appBaseUrl = (process.env.NODE_ENV.toUpperCase()===ENV.LOCALHOST) ? `http://localhost:${PORT}` : 'https://alex-devex-app.herokuapp.com'
// On successful install, users will be redirected to /oauth-callback
const REDIRECT_URI = `${appBaseUrl}/oauth-callback`;

//===========================================================================//

// Use a session to keep track of client ID
app.use(session({
  secret: Math.random().toString(36).substring(2),
  resave: false,
  saveUninitialized: true
}));
 
//================================//
//   Running the OAuth 2.0 Flow   //
//================================//

// Step 1
// Build the authorization URL to redirect a user
// to when they choose to install the app
let apiBaseUrl;
let authUrl;
const buildHubspotUrls = () => {
  const hubspotBaseUrl = (hubspotEnv!==ENV.QA) ? 'https://app.hubspot.com' : 'https://app.hubspotqa.com';
  apiBaseUrl = (hubspotEnv!==ENV.QA) ? 'https://api.hubapi.com' : 'https://api.hubapiqa.com';
  authUrl =
    `${hubspotBaseUrl}/oauth/authorize` +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` + // app's client ID
    `&scope=${encodeURIComponent(SCOPES)}` + // scopes being requested by the app
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; // where to send the user after the consent page
}
buildHubspotUrls();


// Redirect the user from the installation page to
// the authorization URL
app.get('/install', (req, res) => {
  console.log('');
  console.log('=== Initiating OAuth 2.0 flow with HubSpot ===');
  console.log('');
  console.log("===> Step 1: Redirecting user to your app's OAuth URL");
  console.log(authUrl)
  res.redirect(authUrl);
  console.log('===> Step 2: User is being prompted for consent by HubSpot');
});

// Step 2
// The user is prompted to give the app access to the requested
// resources. This is all done by HubSpot, so no work is necessary
// on the app's end

// Step 3
// Receive the authorization code from the OAuth 2.0 Server,
// and process it based on the query parameters that are passed
app.get('/oauth-callback', async (req, res) => {
  console.log('===> Step 3: Handling the request sent by the server');

  // Received a user authorization code, so now combine that with the other
  // required values and exchange both for an access token and a refresh token
  if (req.query.code) {
    console.log('       > Received an authorization token');

    const authCodeProof = {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: req.query.code
    };

    // Step 4
    // Exchange the authorization code for an access token and refresh token
    console.log('===> Step 4: Exchanging authorization code for an access token and refresh token');
    const token = await exchangeForTokens(req.sessionID, authCodeProof);
    if (token.message) {
      console.log({token, CLIENT_ID, CLIENT_SECRET})
      return res.redirect(`/error?msg=${token.message}`);
    }

    // Once the tokens have been retrieved, use them to make a query
    // to the HubSpot API
    res.redirect(`/`);
  }
});

//==========================================//
//   Exchanging Proof for an Access Token   //
//==========================================//

const exchangeForTokens = async (userId, exchangeProof) => {
  try {
    const responseBody = await request.post(`${apiBaseUrl}/oauth/v1/token`, {
      form: exchangeProof
    });
    // Usually, this token data should be persisted in a database and associated with
    // a user identity.
    const tokens = JSON.parse(responseBody);
    refreshTokenStore[userId] = tokens.refresh_token;
    accessTokenCache.set(userId, tokens.access_token, Math.round(tokens.expires_in * 0.75));

    console.log('       > Received an access token and refresh token');
    return tokens.access_token;
  } catch (e) {
    console.error(`       > Error exchanging ${exchangeProof.grant_type} for access token`);
    return JSON.parse(e.response.body);
  }
};

const refreshAccessToken = async (userId) => {
  const refreshTokenProof = {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshTokenStore[userId]
  };
  return await exchangeForTokens(userId, refreshTokenProof);
};

const getAccessToken = async (userId) => {
  // If the access token has expired, retrieve
  // a new one using the refresh token
  if (!accessTokenCache.get(userId)) {
    console.log('Refreshing expired access token');
    await refreshAccessToken(userId);
  }
  return accessTokenCache.get(userId);
};

const isAuthorized = (userId) => {
  return refreshTokenStore[userId] ? true : false;
};

//====================================================//
//   Using an Access Token to Query the HubSpot API   //
//====================================================//

const getContact = async (accessToken) => {
  console.log('');
  console.log('=== Retrieving a contact from HubSpot using the access token ===');
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
    console.log('===> Replace the following request.get() to test other API calls');
    console.log(`===> request.get(\'${apiBaseUrl}/contacts/v1/lists/all/contacts/all?count=1\')`);
    const result = await request.get(`${apiBaseUrl}/contacts/v1/lists/all/contacts/all?count=1`, {
      headers: headers
    });

    return JSON.parse(result).contacts[0];
  } catch (e) {
    console.error('  > Unable to retrieve contact');
    return JSON.parse(e.response.body);
  }
};

//========================================//
//   Displaying information to the user   //
//========================================//

const displayContactName = (res, contact) => {
  if (contact.status === 'error') {
    res.write(`<p>Unable to retrieve contact! Error Message: ${contact.message}</p>`);
    return;
  }
  const { firstname, lastname } = contact.properties;
  res.write(`<p>Contact name: ${firstname.value} ${lastname.value}</p>`);
};

app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h1>HubSpot OAuth 2.0 Quickstart App</h1>`);
  res.write(`<h2>Node Env: ${process.env.NODE_ENV}</h2>`);
  res.write(`<h2>Active Hubspot Env: ${hubspotEnv}</h2>`);
  // add a little btn to toggle between QA and PROD
  res.write(`<p>Toggle between Hubspot QA and PROD Urls for interacting with oAuth and Hubspot Accounts</p>`);
  res.write(`<button id="env-toggle-btn">Toggle Hubspot Env</button>`);
  // make local api call
  res.write(`
  <script>
    document.getElementById("env-toggle-btn").addEventListener("click", ()=> {
      fetch('${appBaseUrl}/env-toggle')
      .then(response => response.json())
      .then(data => console.log(data));
    });
  </script>
  `);
  if (isAuthorized(req.sessionID)) {
    const accessToken = await getAccessToken(req.sessionID);
    const contact = await getContact(accessToken);
    res.write(`<h4>Access token: ${accessToken}</h4>`);
    displayContactName(res, contact);
  }
  res.write(`<p>If you switch environments you might need to reinstsall the app</p>`);
  res.write(`<a href="/install"><h3>Install the app</h3></a>`);
  res.write(`<h2 style='color:red'>If you toggle between environments refresh the page, no react here</h2>`);
  res.end();
});

app.get('/env-toggle', async (req, res) => {
  hubspotEnv = (hubspotEnv===ENV.QA) ? ENV.PROD : ENV.QA;
  buildHubspotUrls();
  generateClientCredentials();
  res.send({hubspotEnv});
});

app.get('/error', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});

app.post('/webhook', (req, res) => {
  console.log({req});
});

app.listen(PORT, () => console.log(`=== Starting your app on ${appBaseUrl} ===`));
opn(`${appBaseUrl}`);
