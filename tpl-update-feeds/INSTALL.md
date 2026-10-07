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
- Create columns (in any order, names must match exactly): 
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
- Prepare every tab named in the column Target tab:
  - Row 1 is the header row with columns (in any order, names must match exactly, case-sensitive):
    - Title
    - Description
    - Author
    - Link
    - Date found
    - Publication Date
  - Heading rows (Title = the Label, Link empty) are optional. If a label has no heading row, the script creates one at the bottom of the tab when it finds new titles. To place a list elsewhere, add its heading row by hand. A label must appear at most once per tab. New titles are inserted directly under the heading.
- Extensions - Apps Script - Name the project, Save
- Libraries - Add a library, Paste the Script ID and look up the script, choose the right version, set Identifier to `tplupdatefeeds`, press `Add`
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

- Save the Google Apps project
- Reload the worksheet to see the new `Library -> Check feeds now` menu.

## Making changes

### Making changes in the library
- Update code in Code.gs in the project `tpl-update-feeds`
- Deploy - New deployment - Select type: Library - Enter description - Deploy
- Make note of the deployment version

### Reflecting changes in the worksheet

- Check that data validation rules are still aligned with a new code, update if needed
- Check that the header names on the Feeds tab and on the target tabs are still aligned with a new code (`CONFIG.HEADERS` and `CONFIG.TAB_HEADERS` in Code.gs), update if needed
- Extensions - Apps Script - Libraries - tpl-update-feeds - Select the new version of the library
- Save

## Upgrading from an earlier version

Target tabs used to have the columns Label, Link and Date found, and the script found them by position. The columns are now found by header name, so before selecting the new library version:
- On every target tab, make sure row 1 is the header row
- Rename the first column header from Label to Title
- Insert new columns named Description, Author and Publication Date (anywhere)
- Existing rows keep these cells empty; only titles added from now on get them

Until this is done, a feed on that tab fails with a message such as `Column "Author" not found in row 1 of tab "..."` in the Log cell.  