use serde::Serialize;

/// Unified error type crossing the Tauri/REST boundary.
///
/// `field_errors` carries per-field validation messages so the frontend
/// form store can map them back onto inputs (spec §7.3).
#[derive(Debug, thiserror::Error)]
pub enum BantoError {
    #[error("resource not found: {resource}/{id}")]
    NotFound { resource: String, id: String },

    #[error("validation failed")]
    Validation { field_errors: Vec<FieldError> },

    #[error("unauthorized")]
    Unauthorized,

    /// The caller is authenticated but their role does not permit this
    /// action (spec §10/M10 RBAC), e.g. a `viewer` calling a mutating
    /// endpoint or a non-`admin` calling user-management routes. Distinct
    /// from `Unauthorized` (no/invalid session at all), which is a 401.
    #[error("forbidden")]
    Forbidden,

    #[error("storage error: {0}")]
    Storage(String),

    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

/// Serialized form sent to the frontend. Tauri command handlers and REST
/// handlers must both produce this shape.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ErrorBody {
    NotFound { resource: String, id: String },
    Validation { field_errors: Vec<FieldError> },
    Unauthorized,
    Forbidden,
    Storage { message: String },
    Other { message: String },
}

impl From<&BantoError> for ErrorBody {
    fn from(err: &BantoError) -> Self {
        match err {
            BantoError::NotFound { resource, id } => ErrorBody::NotFound {
                resource: resource.clone(),
                id: id.clone(),
            },
            BantoError::Validation { field_errors } => ErrorBody::Validation {
                field_errors: field_errors.clone(),
            },
            BantoError::Unauthorized => ErrorBody::Unauthorized,
            BantoError::Forbidden => ErrorBody::Forbidden,
            BantoError::Storage(message) => ErrorBody::Storage {
                message: message.clone(),
            },
            BantoError::Other(message) => ErrorBody::Other {
                message: message.clone(),
            },
        }
    }
}

impl Serialize for BantoError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ErrorBody::from(self).serialize(serializer)
    }
}
