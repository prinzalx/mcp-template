use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{Implementation, ServerCapabilities, ServerConfig},
    schemars, tool, tool_handler, tool_router,
};

/// Arguments of the `echo` tool.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct EchoRequest {
    #[schemars(description = "The text to send back unchanged")]
    pub text: String,
}

/// The MCP service. A new project adds modules under `src/` and registers their tools on the
/// `#[tool_router]` impl below; the transport wiring at the end of this file stays untouched.
#[derive(Clone)]
pub struct TemplateServer {
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl TemplateServer {
    #[tool(description = "Return the given text unchanged, proving the tool round trip.")]
    async fn echo(
        &self,
        Parameters(EchoRequest { text }): Parameters<EchoRequest>,
    ) -> Result<String, McpError> {
        Ok(text)
    }
}

impl Default for TemplateServer {
    fn default() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for TemplateServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            // Without this the client sees "rmcp", because rmcp's own build environment is what
            // its default implementation identity reads.
            .with_server_info(Implementation::new(
                env!("CARGO_PKG_NAME"),
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions("mcp-template: the transport works, add your own tools.")
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // stdout carries JSON-RPC, so logs have to go to stderr.
    tracing_subscriber::fmt().with_writer(std::io::stderr).init();

    let service = TemplateServer::default().serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
