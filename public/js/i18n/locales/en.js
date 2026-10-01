// English bundle — the permanent fallback. Every key the app renders must
// exist here: when a translation is missing in another locale the English
// string is used, so a user never sees a blank surface or a raw key.
//
// Hand-maintained. No machine translation, no external services.
export default {
  // shell
  'app.starting': 'Starting Homeroom Maps',
  'common.loading': 'Loading',
  'common.comingSoon': 'Coming soon',
  'common.tryAgain': 'Try again',

  // navigation
  'nav.main': 'Main',
  'nav.home': 'Home',
  'nav.discover': 'Discover',
  'nav.directions': 'Directions',
  'nav.community': 'Community',
  'nav.profile': 'Profile',

  // errors
  'error.somethingWentWrong': 'Something went wrong',
  'error.screenTitle': 'This screen could not open',
  'error.screenBody': 'Something went wrong while opening this screen.',

  // search
  'search.placeholder': 'Search places',
  'search.clear': 'Clear',
  'search.recentTitle': 'Recent searches',
  'search.idleHint': 'Search countries, cities, streets and places worldwide.',
  'search.searching': 'Searching…',
  'search.listboxLabel': 'Suggestions',
  'search.noResultsTitle': 'No results',
  'search.noResults': 'No matches for "{query}". Check the spelling or try a different name.',
  'search.errorBusy': 'Search is busy right now',
  'search.errorUnavailable': 'Search is unavailable right now',
  'search.errorFallback': 'We could not reach the search service. Try again in a moment.',
  'search.osmLine': 'Search data © OpenStreetMap contributors',

  // selected place
  'place.selected': 'Selected place',
  'place.remove': 'Remove',

  // map
  'map.srLabel': 'Interactive world map',
  'map.loading': 'Loading map',
  'map.unconfiguredTitle': 'Map is not configured yet',
  'map.unconfiguredBody':
    'No map provider is connected. Set MAP_PROVIDER and a style URL to turn the map on.',
  'map.unsupportedTitle': 'This device cannot show the interactive map',
  'map.unsupportedBody':
    'The map needs WebGL, which this browser or device does not provide. Everything else on this screen still works.',
  'map.errorProviderTitle': 'The map provider could not serve the map',
  'map.errorTitle': 'We could not load the map',
  'map.errorBody': 'Check your connection and try again.',
  'map.zoomIn': 'Zoom in',
  'map.zoomOut': 'Zoom out',
  'map.resetNorth': 'Reset north',
  'map.myLocation': 'My location',
  'map.layers': 'Map layers',
  'map.layersSr': 'Map layers, coming soon',
  'map.dataPrefix': 'Map data: ',
  'map.needShell': 'Open Homeroom Maps inside Homeroom to use your location.',
  'map.askFailed': 'We could not ask for your location. Please try again.',
  'map.declined': 'Location access was declined. The map still works without it.',
  'map.denied': 'Location access was denied. The map still works without it.',
  'map.notAvailable': 'Your location is not available to the app. The map still works without it.',
  'map.grantedReloading': 'Location enabled. Homeroom Maps will reopen to finish.',
  'map.noGeolocation': 'This device cannot provide a location.',
  'map.showingAccuracy': 'Showing your location (accurate to about {distance}).',
  'map.showing': 'Showing your location.',
  'map.locateFailed': 'We could not determine your location right now. Please try again.',

  // home
  'home.placesTitle': 'Places',
  'home.placesBody': 'Points of interest, saved places and map contributions are coming soon.',

  // discover
  'discover.idleTitle': 'Find a place',
  'discover.idleBody': 'Search for a country, city, street or place to see it here.',
  'discover.noResultsBody': 'No matches for that search. Check the spelling or try a different name.',

  // directions
  'directions.emptyTitle': 'No directions yet',
  'directions.emptyBody': 'Route planning and navigation will appear here.',
  'directions.panelTitle': 'Route planning',
  'directions.panelBody': 'Turn-by-turn navigation is coming soon.',

  // profile
  'profile.signedInAs': 'Signed in as',
  'profile.notSignedIn': 'Not signed in',
  'profile.signedInNote': 'You are signed in through Homeroom. There is no separate Homeroom Maps account.',
  'profile.signedOutNote':
    'Open Homeroom Maps inside Homeroom to sign in. Sign-in is handled by Homeroom, not by this app.',
  'profile.loadError': 'We could not load your profile',
  'profile.appearance': 'Appearance',
  'profile.appearanceBody': 'Follow the platform theme, or set this app to Light or Dark.',
  'profile.themeGroup': 'Theme',
  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'profile.language': 'Language',
  'profile.languageBody':
    'Choose the language this app uses, or follow your Homeroom and device settings.',
  'profile.languageGroup': 'Language',
  'lang.system': 'System',
  'profile.units': 'Units',
  'profile.unitsBody': 'Choose metric or imperial for distances, or follow your device.',
  'profile.unitsGroup': 'Units',
  'units.metric': 'Metric',
  'units.imperial': 'Imperial',
  'profile.savedTitle': 'Saved places',
  'profile.savedBody': 'Saved places and trip planning are coming soon.',
  'profile.moreSoonTitle': 'More soon',
  'profile.moreSoonBody': 'Contribution history and notification settings will appear here.',
};
