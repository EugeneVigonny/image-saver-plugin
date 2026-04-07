use serde::Serialize;
use utoipa::ToSchema;

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, ToSchema)]
pub struct HealthResponse {
    pub ok: bool,
    pub version: &'static str,
    pub protocol: u16,
}

#[must_use]
pub fn health_response() -> HealthResponse {
    HealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        protocol: PROTOCOL_VERSION,
    }
}
