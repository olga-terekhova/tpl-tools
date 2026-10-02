# Setup of tpl-update-feeds

## Initial deploy

### Initial deploy of the code library
- Create a new project on scripts.google.com
- Name it `tpl-update-feeds` and save
- Insert code into Code.gs window
- Deploy - New deployment - Select type: Library - Enter description - Deploy
- Make note of the deployment version (should be 1 for the initial deployment)
- Go to Project Settings - IDs, Copy Script ID

### Initial deploy in a worksheet
- Create a new sheet named Feeds
- Create columns: 
  - Label
  - Target tab
  - Feed URL
  - Depth
  - Log
- Set Data validation rules for the column Depth (Data -> Data validation), expected values:
  - Full
  - Recent
  - None
- Fill in with values
- Extensions - Apps Script - Name the project, Save
- Libraries - Add a library, Paste the Script ID and look up the script, choose the right version
- Insert into Code.js the initialization of the menu item linked to the library:
```
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Library')
    .addItem('Check feeds now', 'checkFeeds')
    .addToUi();
}

function checkFeeds() {
  tplupdatefeeds.checkFeeds();
}
```

## Making changes

### Making changes in the library
- Update code in Code.gs in the project `tpl-update-feeds`
- Deploy - New deployment - Select type: Library - Enter description - Deploy
- Make note of the deployment version

### Reflecting changes in the worksheet

- Check that data validation rules are still aligned with a new code, update if needed
- Extensions - Apps Script - Libraries - tpl-update-feeds - Select the new version of the library
- Save
