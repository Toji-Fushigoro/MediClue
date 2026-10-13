#include <iostream>
#include <string>
#include <ctime>
#include <cstdio>
#include <vector>
#include <algorithm>

using namespace std;

struct DispatchDecision
{
    bool found = false;
    int appointmentId = -1;
    int doctorId = -1;
    string patientName;
    string reason;
};

struct PatientProcess
{
    int appointmentId;
    int patientId;
    int doctorId;
    string patientName;
    string doctorName;
    string priority;
    string appointmentType;
    string arrivalTime;
    long long waitingMinutes;
    int priorityTier;
};

int getPriorityTier(string priority)
{
    if (priority == "Critical" || priority == "Emergency")
        return 0;
    else if (priority == "High" || priority == "Urgent")
        return 1;
    else if (priority == "Medium" || priority == "Normal")
        return 2;
    else
        return 3;
}

long long calculateWaitingMinutes(string arrivalTime)
{
    int hours = 0, minutes = 0;

    if (sscanf(arrivalTime.c_str(), "%d:%d", &hours, &minutes) != 2)
        return 0;

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59)
        return 0;

    time_t now = time(0);
    tm *local = localtime(&now);

    if (local == nullptr)
        return 0;

    int currentTime = local->tm_hour * 60 + local->tm_min;
    int arrival = hours * 60 + minutes;

    if (arrival > currentTime)
        return 0;

    return currentTime - arrival;
}

void applyPriorityScheduling(vector<PatientProcess>& readyQueue)
{
    for (auto& process : readyQueue)
    {
        process.priorityTier = getPriorityTier(process.priority);
        process.waitingMinutes = calculateWaitingMinutes(process.arrivalTime);
    }

    sort(readyQueue.begin(), readyQueue.end(),
        [](const PatientProcess& a, const PatientProcess& b)
        {
            if (a.priorityTier != b.priorityTier)
                return a.priorityTier < b.priorityTier;

            if (a.waitingMinutes != b.waitingMinutes)
                return a.waitingMinutes > b.waitingMinutes;

            return a.appointmentId < b.appointmentId;
        });
}

bool isDoctorAvailable(int doctorId, const vector<int>& availableDoctors)
{
    for (int id : availableDoctors)
    {
        if (id == doctorId)
            return true;
    }

    return false;
}

DispatchDecision selectNextPatientForDoctor(
    const vector<PatientProcess>& readyQueue,
    int availableDoctorId)
{
    DispatchDecision result;
    result.doctorId = availableDoctorId;

    for (const auto& process : readyQueue)
    {
        if (process.doctorId == availableDoctorId)
        {
            result.found = true;
            result.appointmentId = process.appointmentId;
            result.patientName = process.patientName;
            result.reason = "Patient selected successfully";
            return result;
        }
    }

    result.reason = "No waiting patient for this doctor";
    return result;
}

DispatchDecision checkDoctorAvailability(
    const vector<PatientProcess>& readyQueue,
    const vector<int>& availableDoctors)
{
    for (const auto& process : readyQueue)
    {
        if (isDoctorAvailable(process.doctorId, availableDoctors))
        {
            DispatchDecision result;
            result.found = true;
            result.appointmentId = process.appointmentId;
            result.doctorId = process.doctorId;
            result.patientName = process.patientName;
            result.reason = "Available doctor assigned successfully";
            return result;
        }
    }

    DispatchDecision result;
    result.reason = "No waiting patient has an available doctor";
    return result;
}

int main()
{
    vector<PatientProcess> readyQueue = {
        {1001, 501, 11, "Patient A", "Doctor X", "Medium", "Booked", "09:05:00"},
        {1002, 502, 11, "Patient B", "Doctor X", "Critical", "Walkin", "09:20:00"},
        {1003, 503, 12, "Patient C", "Doctor Y", "High", "Booked", "09:10:00"},
        {1004, 504, 11, "Patient D", "Doctor X", "Low", "Walkin", "08:45:00"}
    };

    applyPriorityScheduling(readyQueue);

    int rank = 1;

    for (const auto& process : readyQueue)
    {
        cout << rank++ << ". Appointment: " << process.appointmentId
             << " | Patient: " << process.patientName
             << " | Doctor ID: " << process.doctorId
             << " | Priority: " << process.priority
             << " | Waiting Time: " << process.waitingMinutes
             << " minutes\n";
    }

    DispatchDecision decision = selectNextPatientForDoctor(readyQueue, 11);

    if (decision.found)
    {
        cout << "\nDoctor ID: " << decision.doctorId;
        cout << "\nSelected Appointment: " << decision.appointmentId;
        cout << "\nPatient Name: " << decision.patientName;
        cout << "\nReason: " << decision.reason << "\n";
    }
    else
    {
        cout << "\n" << decision.reason << "\n";
    }

    vector<int> availableDoctors = {12};

    DispatchDecision availabilityDecision =
        checkDoctorAvailability(readyQueue, availableDoctors);

    cout << "\nDoctor Availability Check:\n";

    if (availabilityDecision.found)
    {
        cout << "Doctor ID: " << availabilityDecision.doctorId;
        cout << "\nSelected Appointment: " << availabilityDecision.appointmentId;
        cout << "\nPatient Name: " << availabilityDecision.patientName;
        cout << "\nReason: " << availabilityDecision.reason << "\n";
    }
    else
    {
        cout << availabilityDecision.reason << "\n";
    }

    cout << "\nDemo completed successfully.\n";

    return 0;
}