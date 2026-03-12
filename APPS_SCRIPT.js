// =============================================================================
// Google Apps Script — paste this into Extensions → Apps Script in your sheet.
// Deploy as Web App (Execute as: Me, Access: Anyone).
// Copy the URL into APPS_SCRIPT_URL in your .env file.
// =============================================================================

var COL_GAME = "Game";
var COL_ORIGINAL = "Original Price";
var COL_CURRENT = "Current Price";
var COL_DISCOUNT = "Discount";

function getHeaderMap(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    map[String(headers[i]).trim()] = i;
  }
  return map;
}

function doGet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var numRows = sheet.getLastRow();
  if (numRows < 2) {
    return ContentService.createTextOutput(JSON.stringify({ rows: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var headerMap = getHeaderMap(sheet);
  var gameCol = headerMap[COL_GAME];
  if (gameCol === undefined) {
    return ContentService.createTextOutput(JSON.stringify({ error: "No 'Game' column found" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var dataRange = sheet.getRange(2, 1, numRows - 1, sheet.getLastColumn());
  var values = dataRange.getValues();
  var richText = dataRange.getRichTextValues();

  var rows = [];
  for (var r = 0; r < values.length; r++) {
    var gameName = String(values[r][gameCol] || "").trim();
    if (!gameName) continue;

    var gameRt = richText[r][gameCol];
    var linkUrl = gameRt ? gameRt.getLinkUrl() : null;

    rows.push({
      row: r + 2,
      game: gameName,
      url: linkUrl || null,
      originalPrice: headerMap[COL_ORIGINAL] !== undefined ? String(values[r][headerMap[COL_ORIGINAL]] || "").trim() : "",
      currentPrice: headerMap[COL_CURRENT] !== undefined ? String(values[r][headerMap[COL_CURRENT]] || "").trim() : "",
      discount: headerMap[COL_DISCOUNT] !== undefined ? String(values[r][headerMap[COL_DISCOUNT]] || "").trim() : ""
    });
  }

  return ContentService.createTextOutput(JSON.stringify({ rows: rows }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var payload = JSON.parse(e.postData.contents);
  var updates = payload.updates;
  if (!updates || !updates.length) {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, updated: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var headerMap = getHeaderMap(sheet);
  var colGame = headerMap[COL_GAME] + 1;
  var colOriginal = headerMap[COL_ORIGINAL] + 1;
  var colCurrent = headerMap[COL_CURRENT] + 1;
  var colDiscount = headerMap[COL_DISCOUNT] + 1;

  for (var i = 0; i < updates.length; i++) {
    var u = updates[i];
    var row = u.row;

    if (u.game && u.url) {
      var rt = SpreadsheetApp.newRichTextValue()
        .setText(u.game)
        .setLinkUrl(u.url)
        .build();
      sheet.getRange(row, colGame).setRichTextValue(rt);
    } else if (u.game) {
      sheet.getRange(row, colGame).setValue(u.game);
    }

    if (u.originalPrice != null) sheet.getRange(row, colOriginal).setValue(u.originalPrice);
    if (u.currentPrice != null) sheet.getRange(row, colCurrent).setValue(u.currentPrice);
    if (u.discount != null) sheet.getRange(row, colDiscount).setValue(u.discount);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true, updated: updates.length }))
    .setMimeType(ContentService.MimeType.JSON);
}
