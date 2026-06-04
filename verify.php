<?php
header("Content-Type: application/json");

$TELEBIRR_PROXY_KEY = 'YOUR_SECRET_PROXY_KEY_HERE'; // Change this to a secure random string on your server

// Check for proxy key
if (!isset($_GET['key']) || $_GET['key'] !== $TELEBIRR_PROXY_KEY) {
    echo json_encode([
        "success" => false,
        "error" => "Unauthorized: Invalid or missing proxy key"
    ]);
    exit;
}

$reference = $_GET['reference'] ?? null;
if (!$reference) {
    echo json_encode([
        "success" => false,
        "error" => "Missing reference parameter."
    ]);
    exit;
}

$url = "https://transactioninfo.ethiotelecom.et/receipt/" . urlencode($reference);

function fetchReceipt($url) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 15);
    curl_setopt($ch, CURLOPT_USERAGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language: am-ET,am;q=0.9,en-US;q=0.8,en;q=0.7"
    ]);

    // Attempt standard fetch (Secure SSL)
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    $response = curl_exec($ch);
    $error_no = curl_errno($ch);
    $error_msg = curl_error($ch);

    if ($error_no === 0) {
        curl_close($ch);
        return ['success' => true, 'html' => $response];
    }

    // Group specific cURL errors
    $is_ssl_error = in_array($error_no, [35, 51, 58, 59, 60, 64, 66, 77, 82, 83]); // SSL related errors
    $is_connection_error = in_array($error_no, [6, 7, 28]); // 6: COULDNT_RESOLVE_HOST, 7: COULDNT_CONNECT, 28: OPERATION_TIMEDOUT

    curl_close($ch);

    if ($is_ssl_error) {
        return [
            'success' => false,
            'error' => "SSL Certificate issue from Ethiotelecom.",
            'details' => $error_msg
        ];
    }

    if ($is_connection_error) {
        return [
            'success' => false,
            'error' => "Ethiotelecom is unreachable. The proxy might be blocked or Ethiotelecom is experiencing hosting issues.",
            'details' => $error_msg
        ];
    }

    // Any other cURL errors
    return [
        'success' => false,
        'error' => "Failed to fetch receipt from Ethiotelecom.",
        'details' => $error_msg
    ];
}

$fetchResult = fetchReceipt($url);

if (!$fetchResult['success']) {
    echo json_encode([
        "success" => false,
        "error" => $fetchResult['error'],
        "details" => $fetchResult['details']
    ]);
    exit;
}

$html = $fetchResult['html'];
if (empty($html) || strlen($html) < 100) {
    echo json_encode([
        "success" => false,
        "error" => "Failed to fetch receipt or empty response."
    ]);
    exit;
}

// Regex patterns for extracting specific values
function extractSettledAmount($html) {
    $pattern1 = '/የተከፈለው\s+መጠን\/Settled\s+Amount.*?<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is';
    if (preg_match($pattern1, $html, $matches)) return trim($matches[1]);

    $pattern2 = '/<tr[^>]*>.*?የተከፈለው\s+መጠን\/Settled\s+Amount.*?<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is';
    if (preg_match($pattern2, $html, $matches)) return trim($matches[1]);

    $pattern3 = '/Settled\s+Amount.*?([\d,]+(?:\.\d+)?\s+Birr)/is';
    if (preg_match($pattern3, $html, $matches)) return trim($matches[1]);

    $pattern4 = '/የክፍያ\s+ዝርዝር\/Transaction\s+details.*?<tr[^>]*>.*?<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is';
    if (preg_match($pattern4, $html, $matches)) return trim($matches[1]);

    return "";
}

function extractServiceFee($html) {
    $patterns = [
        '/የአገልግሎት\s+ክፍያ\/Service\s+fee(?!\s+ተ\.እ\.ታ).*?<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is',
        '/<tr[^>]*>.*?የአገልግሎት\s+ክፍያ\/Service\s+fee(?!\s+ተ\.እ\.ታ).*?<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is',
        '/Service\s+fee(?!\s+VAT).*?([\d,]+(?:\.\d+)?\s+Birr)/is'
    ];

    foreach ($patterns as $pattern) {
        if (preg_match($pattern, $html, $matches)) {
            return trim($matches[1]);
        }
    }

    return "";
}

// Enhanced regex extraction functions
function extractWithRegex($html, $labelPatterns, $valuePattern = null) {
    if (!is_array($labelPatterns)) {
        $labelPatterns = [$labelPatterns];
    }
    if ($valuePattern === null) {
        $valuePattern = '([^<]+)';
    }

    foreach ($labelPatterns as $labelPattern) {
        $pattern = '/<td[^>]*>\s*' . preg_quote($labelPattern, '/') . '\s*<\/td>\s*<td[^>]*>\s*' . $valuePattern . '/is';
        if (preg_match($pattern, $html, $matches)) {
            return preg_replace('/\s+/u', ' ', trim(strip_tags($matches[1])));
        }
    }

    return "";
}

function extractReceiptNoRegex($html) {
    // Extract receipt number from the transaction details table
    $pattern = '/<td[^>]*class="[^"]*receipttableTd[^"]*receipttableTd2[^"]*"[^>]*>\s*([A-Z0-9]+)\s*<\/td>/i';
    if (preg_match($pattern, $html, $matches)) {
        return trim($matches[1]);
    }
    return "";
}

function extractDateRegex($html) {
    // Extract date in format DD-MM-YYYY HH:MM:SS
    $pattern = '/(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/';
    if (preg_match($pattern, $html, $matches)) {
        return trim($matches[1]);
    }
    return "";
}

// Fallback DOM parsing functions (keeping your original approach as backup)
libxml_use_internal_errors(true);
$dom = new DOMDocument();
$dom->loadHTML('<?xml encoding="utf-8" ?>' . $html);
$xpath = new DOMXPath($dom);
libxml_clear_errors();

function xpathLiteral($value) {
    if (strpos($value, "'") === false) {
        return "'" . $value . "'";
    }

    if (strpos($value, '"') === false) {
        return '"' . $value . '"';
    }

    $parts = explode("'", $value);
    $segments = [];
    $lastIndex = count($parts) - 1;

    foreach ($parts as $index => $part) {
        if ($part !== '') {
            $segments[] = "'" . $part . "'";
        }

        if ($index < $lastIndex) {
            $segments[] = '"\'"';
        }
    }

    return 'concat(' . implode(', ', $segments) . ')';
}

function getNextCellText($xpath, $labels) {
    if (!is_array($labels)) {
        $labels = [$labels];
    }

    foreach ($labels as $label) {
        $query = "//td[contains(normalize-space(.), " . xpathLiteral($label) . ")]/following-sibling::td[1]";
        $nodeList = $xpath->query($query);
        if ($nodeList && $nodeList->length > 0) {
            foreach ($nodeList as $node) {
                $value = trim($node->textContent ?? '');
                if ($value !== '') {
                    return preg_replace('/\s+/u', ' ', $value);
                }
            }
        }
    }

    return "";
}

// Extract values using regex first, fallback to DOM parsing
$settledAmount = extractSettledAmount($html) ?: getNextCellText($xpath, ["የተከፈለው መጠን/Settled Amount", "Settled Amount"]);
$serviceFee = extractServiceFee($html) ?: getNextCellText($xpath, ["የአገልግሎት ክፍያ/Service fee", "Service fee"]);

// --- Bank name extraction logic ---
$creditedPartyName = extractWithRegex($html, "የገንዘብ ተቀባይ ስም/Credited Party name") ?: getNextCellText($xpath, "የገንዘብ ተቀባይ ስም/Credited Party name");
$creditedPartyAccountNo = extractWithRegex($html, "የገንዘብ ተቀባይ ቴሌብር ቁ./Credited party account no") ?: getNextCellText($xpath, "የገንዘብ ተቀባይ ቴሌብር ቁ./Credited party account no");
$bankName = "";

$bankAccountNumberRaw = extractWithRegex($html, "የባንክ አካውንት ቁጥር/Bank account number") ?: getNextCellText($xpath, "የባንክ አካውንት ቁጥር/Bank account number");

if ($bankAccountNumberRaw) {
    $bankName = $creditedPartyName; // The original credited party name is the bank
    if (preg_match('/(\d+)\s+(.*)/', $bankAccountNumberRaw, $m)) {
        $creditedPartyAccountNo = trim($m[1]);
        $creditedPartyName = trim($m[2]);
    }
}


$response = [
    "success" => true,
    "data" => [
        "payerName" => extractWithRegex($html, ["የከፋይ ስም/Payer Name", "Payer Name"]) ?: getNextCellText($xpath, ["የከፋይ ስም/Payer Name", "Payer Name"]),
        "payerTelebirrNo" => extractWithRegex($html, ["የከፋይ ቴሌብር ቁ./Payer telebirr no.", "Payer telebirr no.", "Payer Telebirr No."]) ?: getNextCellText($xpath, ["የከፋይ ቴሌብር ቁ./Payer telebirr no.", "Payer telebirr no.", "Payer Telebirr No."]),
        "creditedPartyName" => $creditedPartyName,
        "creditedPartyAccountNo" => $creditedPartyAccountNo,
        "bankName" => $bankName,
        "customerNote" => extractWithRegex($html, ["የደንበኛ መልዕክት/Customer Note", "Customer Note"]) ?: getNextCellText($xpath, ["የደንበኛ መልዕክት/Customer Note", "Customer Note"]),
        "transactionStatus" => extractWithRegex($html, ["የክፍያው ሁኔታ/transaction status", "Transaction status", "transaction status"]) ?: getNextCellText($xpath, ["የክፍያው ሁኔታ/transaction status", "Transaction status", "transaction status"]),
        "receiptNo" => extractReceiptNoRegex($html) ?: getNextCellText($xpath, ["የክፍያ ቁጥር/Receipt No.", "Receipt No."]),
        "paymentDate" => extractDateRegex($html) ?: getNextCellText($xpath, ["የክፍያ ቀን/Payment date", "Payment date"]),
        "settledAmount" => $settledAmount,
        "serviceFee" => $serviceFee,
        "serviceFeeVAT" => extractWithRegex($html, ["የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT", "Service fee VAT"]) ?: getNextCellText($xpath, ["የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT", "Service fee VAT"]),
        "totalPaidAmount" => extractWithRegex($html, ["ጠቅላላ የተከፈለ/Total Paid Amount", "Total Paid Amount"]) ?: getNextCellText($xpath, ["ጠቅላላ የተከፈለ/Total Paid Amount", "Total Paid Amount"])
    ]
];

echo json_encode($response, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
?>
