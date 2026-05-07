using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

public class Script : ScriptBase
{
    public override async Task<HttpResponseMessage> ExecuteAsync()
    {
        var operationId = ResolveOperationId(this.Context.OperationId);

        if (operationId == "CreateZendeskTicketFlat")
        {
            return await HandleCreateZendeskTicketFlat().ConfigureAwait(false);
        }

        if (operationId == "AddCommentToTicketFlat")
        {
            return await HandleAddCommentToTicket().ConfigureAwait(false);
        }

        var badRequest = new HttpResponseMessage(HttpStatusCode.BadRequest);
        badRequest.Content = CreateJsonContent(new JObject
        {
            ["error"] = "unknown_operation",
            ["description"] = $"Unknown operation ID '{operationId}'",
        }.ToString());
        return badRequest;
    }

    private static string ResolveOperationId(string operationId)
    {
        try
        {
            var decoded = Convert.FromBase64String(operationId);
            return System.Text.Encoding.UTF8.GetString(decoded);
        }
        catch
        {
            return operationId;
        }
    }

    private async Task<HttpResponseMessage> HandleCreateZendeskTicketFlat()
    {
        var requestJson = JObject.Parse(
            await this.Context.Request.Content.ReadAsStringAsync().ConfigureAwait(false)
        );

        var ticket = new JObject
        {
            ["subject"] = (string)requestJson["subject"],
            ["comment"] = new JObject
            {
                ["body"] = (string)requestJson["commentBody"],
                ["public"] = requestJson["commentPublic"]?.Value<bool?>() ?? true,
            },
            ["requester"] = new JObject
            {
                ["name"] = (string)requestJson["requesterName"],
                ["email"] = (string)requestJson["requesterEmail"],
            },
            ["priority"] = (string)(requestJson["priority"] ?? "normal"),
            ["status"] = (string)(requestJson["status"] ?? "new"),
        };

        if (requestJson["tags"] is JArray tagsArray && tagsArray.Any())
        {
            ticket["tags"] = tagsArray;
        }

        var transformedPayload = new JObject
        {
            ["ticket"] = ticket,
        };

        this.Context.Request.Method = HttpMethod.Post;
        this.Context.Request.Content = CreateJsonContent(transformedPayload.ToString());

        return await this.Context.SendAsync(this.Context.Request, this.CancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<HttpResponseMessage> HandleAddCommentToTicket()
    {
        var requestJson = JObject.Parse(
            await this.Context.Request.Content.ReadAsStringAsync().ConfigureAwait(false)
        );

        var comment = new JObject
        {
            ["body"] = (string)requestJson["commentBody"],
            ["public"] = requestJson["commentPublic"]?.Value<bool?>() ?? true,
        };

        // If author_id is provided, set it on the comment so Zendesk
        // attributes the message to that user (e.g. the requester)
        var authorId = requestJson["authorId"]?.Value<long?>();
        if (authorId.HasValue && authorId.Value > 0)
        {
            comment["author_id"] = authorId.Value;
        }

        var transformedPayload = new JObject
        {
            ["ticket"] = new JObject
            {
                ["comment"] = comment,
            },
        };

        this.Context.Request.Method = HttpMethod.Put;
        this.Context.Request.Content = CreateJsonContent(transformedPayload.ToString());

        return await this.Context.SendAsync(this.Context.Request, this.CancellationToken)
            .ConfigureAwait(false);
    }
}
