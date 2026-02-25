<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$VALID_PROXY_KEY = 'YOUR_SECRET_PROXY_KEY_HERE'; // Change this to a secure random string on your server

// Check for proxy key
if (!isset($_GET['key']) || $_GET['key'] !== $VALID_PROXY_KEY) {
    echo json_encode([
        'success' => false,
        'responseCode' => '401',
        'responseDescription' => 'Unauthorized: Invalid or missing proxy key'
    ]);
    exit;
}

// Check if reference is provided
if (!isset($_GET['reference']) || empty(trim($_GET['reference']))) {
    echo json_encode([
        'success' => false,
        'responseCode' => '400',
        'responseDescription' => 'Missing reference parameter'
    ]);
    exit;
}

$trxNo = urlencode(trim($_GET['reference']));
$url = "https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo=" . $trxNo;

$isDebug = isset($_GET['debug']) && $_GET['debug'] === 'true';

if ($isDebug) {
    echo "DEBUG: Starting cURL request to $url\n";
    echo "DEBUG: Proxy Key Validated.\n";
}

// Initialize cURL
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); // Ignore SSL errors
curl_setopt($ch, CURLOPT_TIMEOUT, 60); // 60s timeout

if ($isDebug) {
    // Enable verbose output to catch connection hangs
    curl_setopt($ch, CURLOPT_VERBOSE, true);
    $verbose = fopen('php://temp', 'w+');
    curl_setopt($ch, CURLOPT_STDERR, $verbose);
}

// Set exactly the same headers the backend uses
$headers = [
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept: application/json, text/plain, */*',
    'Referer: https://m-pesabusiness.safaricom.et/'
];
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

if ($isDebug) {
    echo "DEBUG: Executing cURL...\n";
}

// Execute request
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);
curl_close($ch);

if ($isDebug) {
    rewind($verbose);
    $verboseLog = stream_get_contents($verbose);
    echo "DEBUG: HTTP Code: $httpCode\n";
    echo "DEBUG: cURL Error: $error\n";
    echo "DEBUG: Verbose Trace:\n$verboseLog\n";
    echo "DEBUG: Raw Response Length: " . strlen((string)$response) . " bytes\n";
    exit;
}

if ($response === false) {
    echo json_encode([
        'success' => false,
        'responseCode' => '500',
        'responseDescription' => 'cURL Error: ' . $error
    ]);
    exit;
}

// Return exactly what Safaricom returns so the parsing logic works properly
echo $response;
?>
