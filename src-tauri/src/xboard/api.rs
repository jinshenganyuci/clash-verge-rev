use super::{Error, Result};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

const API: &str = "https://ikun.iil.im/api/v1";
const MAX_RESPONSE: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum XboardOperation {
    RegistrationPolicy,
    SendEmailCode,
    Nodes,
    Traffic,
    Knowledge,
    Tickets,
    TicketSave,
    TicketReply,
    TicketClose,
    Orders,
    OrderDetail,
    Invites,
    InviteSave,
    InviteDetails,
    Transfer,
    Withdraw,
    UserInfo,
    UserConfig,
    UserUpdate,
    ChangePassword,
    ResetSecurity,
    TelegramBot,
}

impl XboardOperation {
    pub const fn authenticated(self) -> bool {
        !matches!(self, Self::RegistrationPolicy | Self::SendEmailCode)
    }

    fn route(self) -> (&'static str, Method, &'static [&'static str]) {
        match self {
            Self::RegistrationPolicy => ("guest/comm/config", Method::GET, &[]),
            Self::SendEmailCode => ("passport/comm/sendEmailVerify", Method::POST, &["email"]),
            Self::Nodes => ("user/server/fetch", Method::GET, &[]),
            Self::Traffic => ("user/stat/getTrafficLog", Method::GET, &[]),
            Self::Knowledge => ("user/knowledge/fetch", Method::GET, &["language", "keyword", "id"]),
            Self::Tickets => ("user/ticket/fetch", Method::GET, &["id"]),
            Self::TicketSave => ("user/ticket/save", Method::POST, &["subject", "level", "message"]),
            Self::TicketReply => ("user/ticket/reply", Method::POST, &["id", "message"]),
            Self::TicketClose => ("user/ticket/close", Method::POST, &["id"]),
            Self::Orders => ("user/order/fetch", Method::GET, &[]),
            Self::OrderDetail => ("user/order/detail", Method::GET, &["trade_no"]),
            Self::Invites => ("user/invite/fetch", Method::GET, &[]),
            Self::InviteSave => ("user/invite/save", Method::GET, &[]),
            Self::InviteDetails => ("user/invite/details", Method::GET, &["current", "page_size"]),
            Self::Transfer => ("user/transfer", Method::POST, &["transfer_amount"]),
            Self::Withdraw => ("user/ticket/withdraw", Method::POST, &["withdraw_method", "withdraw_account"]),
            Self::UserInfo => ("user/info", Method::GET, &[]),
            Self::UserConfig => ("user/comm/config", Method::GET, &[]),
            Self::UserUpdate => ("user/update", Method::POST, &["remind_expire", "remind_traffic"]),
            Self::ChangePassword => ("user/changePassword", Method::POST, &["old_password", "new_password"]),
            Self::ResetSecurity => ("user/resetSecurity", Method::GET, &[]),
            Self::TelegramBot => ("user/telegram/getBotInfo", Method::GET, &[]),
        }
    }
}

fn client() -> Result<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .user_agent("IKUN-Windows/2.5.10")
        .build()
        .map_err(|_| Error::network())
}

async fn body(mut response: reqwest::Response) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE as u64) {
        return Err(Error::invalid_response());
    }
    let mut result = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::network())? {
        if result.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err(Error::invalid_response());
        }
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}

pub fn is_session_expired(status: StatusCode, value: &Value, authenticated: bool) -> bool {
    authenticated
        && (status == StatusCode::UNAUTHORIZED
            || (status == StatusCode::FORBIDDEN
                && value["status"] == "fail"
                && value["message"] == "未登录或登陆已过期"))
}

fn decode(status: StatusCode, bytes: &[u8], authenticated: bool) -> Result<Value> {
    let value = serde_json::from_slice::<Value>(bytes).unwrap_or(Value::Null);
    if is_session_expired(status, &value, authenticated) {
        return Err(Error::session_expired());
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(Error::new("XBOARD_RATE_LIMITED", "Too many requests. Please try again later."));
    }
    if status.is_server_error() {
        return Err(Error::new("XBOARD_SERVICE_FAILED", "The account service is temporarily unavailable."));
    }
    if !status.is_success() || value["status"] == "fail" || value["data"] == false {
        let message = match value["message"].as_str() {
            Some("Email already exists") => "This email is already registered. Please sign in.",
            Some("Incorrect email or password") => "Incorrect email or password.",
            Some("Your account has been suspended") => "This account is suspended.",
            Some("Incorrect email verification code") => "The email verification code is incorrect or expired.",
            Some("Registration has closed") => "Registration is closed.",
            Some("Invalid invitation code" | "You must use the invitation code to register") => "A valid invitation code is required.",
            Some("Email verification code has been sent, please request again later") => "A verification code was already sent. Please wait before requesting another.",
            Some("The old password is wrong") => "The current password is incorrect.",
            Some("Insufficient commission balance") => "The commission balance is insufficient.",
            _ => "The account service declined this request. Check the information and try again.",
        };
        return Err(Error::new("XBOARD_REQUEST_FAILED", message));
    }
    if !value.is_object() {
        return Err(Error::invalid_response());
    }
    Ok(value)
}

async fn request(path: &str, method: Method, bearer: Option<&str>, params: Value) -> Result<Value> {
    request_at(API, path, method, bearer, params).await
}

async fn request_at(base: &str, path: &str, method: Method, bearer: Option<&str>, params: Value) -> Result<Value> {
    let mut request = client()?
        .request(method.clone(), format!("{base}/{path}"))
        .header("Accept", "application/json")
        .header("Content-Language", "en-US");
    if let Some(bearer) = bearer {
        request = request.header("Authorization", bearer);
    }
    if method == Method::POST {
        request = request.json(&params);
    } else if let Some(params) = params.as_object() {
        let pairs: Vec<_> = params.iter().map(|(key, value)| {
            (key, value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()))
        }).collect();
        request = request.query(&pairs);
    }
    let response = request.send().await.map_err(|_| Error::network())?;
    let status = response.status();
    decode(status, &body(response).await?, bearer.is_some())
}

pub async fn authenticate(email: &str, password: &str, registration: Option<(&str, &str)>) -> Result<String> {
    if email.len() > 254 || !email.contains('@') || password.len() < 8 || password.len() > 1024 {
        return Err(Error::new("XBOARD_INVALID_INPUT", "Enter a valid email and a password of at least eight characters."));
    }
    let mut params = json!({"email": email.trim(), "password": password});
    let path = if let Some((code, invite)) = registration {
        if !code.is_empty() { params["email_code"] = json!(code); }
        if !invite.is_empty() { params["invite_code"] = json!(invite); }
        "passport/auth/register"
    } else {
        "passport/auth/login"
    };
    let response = request(path, Method::POST, None, params).await.map_err(|error| {
        if registration.is_some() && matches!(error.code, "XBOARD_NETWORK_FAILED" | "XBOARD_SERVICE_FAILED") {
            Error::new("XBOARD_REGISTRATION_UNCERTAIN", "Registration could not be confirmed. The account may already exist. Try signing in before registering again.")
        } else { error }
    })?;
    let bearer = response["data"]["auth_data"].as_str().ok_or_else(Error::invalid_response)?;
    let token = bearer.strip_prefix("Bearer ").ok_or_else(Error::invalid_response)?;
    if token.is_empty() || token.len() > 4096 || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~+/=-".contains(&b)) {
        return Err(Error::invalid_response());
    }
    Ok(bearer.to_owned())
}

pub async fn subscription(bearer: &str) -> Result<Value> {
    let response = request("user/getSubscribe", Method::GET, Some(bearer), json!({})).await?;
    Ok(response["data"].clone())
}

fn checked_params(operation: XboardOperation, params: Value) -> Result<Value> {
    let (_, _, allowed) = operation.route();
    let object = params.as_object().ok_or_else(|| Error::new("XBOARD_INVALID_INPUT", "Invalid request parameters."))?;
    if object.iter().any(|(key, value)| {
        !allowed.contains(&key.as_str())
            || !(value.is_string() || value.is_boolean() || value.is_number())
            || value.as_str().is_some_and(|text| text.len() > 64 * 1024)
    }) {
        return Err(Error::new("XBOARD_INVALID_INPUT", "Invalid request parameters."));
    }
    Ok(params)
}

pub async fn operation(operation: XboardOperation, bearer: Option<&str>, params: Value) -> Result<Value> {
    let params = checked_params(operation, params)?;
    let (path, method, _) = operation.route();
    request(path, method, bearer, params).await
}

pub fn subscription_url(raw: &str) -> Result<tauri::Url> {
    let mut url = tauri::Url::parse(raw).map_err(|_| Error::invalid_response())?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.fragment().is_some()
    {
        return Err(Error::invalid_response());
    }
    let pairs: Vec<_> = url.query_pairs().filter(|(key, _)| key != "flag").map(|(k,v)| (k.into_owned(),v.into_owned())).collect();
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(pairs).append_pair("flag", "mihomo");
    Ok(url)
}

pub async fn download(raw: &str) -> Result<String> {
    let response = client()?.get(subscription_url(raw)?).send().await.map_err(|_| Error::network())?;
    if matches!(response.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return Err(Error::unavailable());
    }
    if !response.status().is_success() {
        return Err(Error::network());
    }
    String::from_utf8(body(response).await?).map_err(|_| Error::invalid_response())
}

pub fn redact(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for key in ["auth_data", "token", "subscribe_url", "password", "uuid"] { object.remove(key); }
            for child in object.values_mut() { redact(child); }
        }
        Value::Array(array) => array.iter_mut().for_each(redact),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden_business_errors_do_not_expire_sessions() {
        assert!(is_session_expired(StatusCode::FORBIDDEN, &json!({"status":"fail", "message":"未登录或登陆已过期"}), true));
        assert!(!is_session_expired(StatusCode::FORBIDDEN, &json!({"status":"fail", "message":"Permission denied"}), true));
        assert!(!is_session_expired(StatusCode::FORBIDDEN, &Value::Null, true));
        assert!(!is_session_expired(StatusCode::UNAUTHORIZED, &Value::Null, false));
    }

    #[test]
    fn subscription_exporter_is_explicit_and_credentials_cannot_change_origin() {
        let url = subscription_url("https://example.com/s/secret?flag=clash&x=1").unwrap();
        assert_eq!(url.query_pairs().filter(|(key, _)| key == "flag").collect::<Vec<_>>(), vec![("flag".into(), "mihomo".into())]);
        assert!(subscription_url("http://example.com/s/secret").is_err());
        assert!(subscription_url("https://user:pass@example.com/s/secret").is_err());
        assert!(checked_params(XboardOperation::Tickets, json!({"url":"https://evil.example"})).is_err());
    }

    #[tokio::test]
    async fn api_mock_preserves_business_errors_and_never_follows_redirects() {
        use warp::Filter as _;
        let routes = warp::path("business").map(|| warp::reply::with_status(warp::reply::json(&json!({"status":"fail","message":"Permission denied"})), StatusCode::FORBIDDEN))
            .or(warp::path("expired").map(|| warp::reply::with_status(warp::reply::json(&json!({"status":"fail","message":"未登录或登陆已过期"})), StatusCode::FORBIDDEN)))
            .or(warp::path("redirect").map(|| warp::redirect::temporary(warp::http::Uri::from_static("http://127.0.0.1:1/should-not-be-requested"))));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(warp::serve(routes).incoming(listener).run());
        let base = format!("http://{address}");
        assert_eq!(request_at(&base,"business",Method::GET,Some("Bearer test"),json!({})).await.unwrap_err().code,"XBOARD_REQUEST_FAILED");
        assert_eq!(request_at(&base,"expired",Method::GET,Some("Bearer test"),json!({})).await.unwrap_err().code,"XBOARD_SESSION_EXPIRED");
        assert_eq!(request_at(&base,"redirect",Method::GET,Some("Bearer test"),json!({})).await.unwrap_err().code,"XBOARD_REQUEST_FAILED");
        server.abort();
    }
}
